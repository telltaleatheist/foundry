import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { documentNames, qualify, typeLabel } from '@shared/documents';
import type { ProjectDocumentKind } from '@shared/types';

import { api } from '../../core/foundry';
import { ProjectsService } from '../../core/projects.service';
import { TabsService, type Tab } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

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
 * ── The groups ───────────────────────────────────────────────────────────────
 *
 * A DOCUMENT OPENED OUT OF A PROJECT BRINGS ITS PROJECT WITH IT. The group
 * header names the book, and under it are that project's ARTEFACTS — the PDF,
 * the EPUB — whether or not they are open. One row per thing the user asked to
 * exist, never one per file: a converted project holds the archived original,
 * the live PDF, the origin it was promoted from and several rotated
 * predecessors, and the person who asked for a searchable book is owed "the
 * PDF", once. So flipping from the PDF to the book made from it is one click,
 * where it used to mean going back to Home and expanding a row that is no longer
 * there. That listing is `listProjects`' own (electron/projects.ts), which is
 * why it moved here rather than being rebuilt: one function decides what a
 * project contains, and this is now its reader.
 *
 * ── And under those, the EXPORTS ─────────────────────────────────────────────
 *
 * *"under the project and indented, there will be terminal files i generated
 * from the project. pdf facsimile, epub, whatever i exported."* An export is not
 * a document row and must not be drawn as one: a document row is one per TYPE
 * and is a base for further work, and there can be four exported EPUBs of one
 * book with nothing made from any of them. So they are their own run, indented a
 * step further in, at the bottom of the group where the newest is first.
 *
 * NAMED BY PRODUCT AND DATE — "Facsimile PDF · 14 Aug" — because that is the
 * pair of facts that tells two of them apart, and because a project's exports all
 * share the book's stem the way its documents do. `.txt` is listed and INERT:
 * this app has no tab that reads plain text, so the row dims itself and offers
 * Show in file manager instead of pretending a click will do something.
 *
 * ── A ROW IS NOT A FILENAME ──────────────────────────────────────────────────
 *
 * THE HEADER NAMES THE BOOK AND THE ROWS NAME ITS FACES: "PDF", "EPUB", "text".
 * They were basenames until now, and a project's documents all share one stem by
 * construction, so the panel read as the same unpronounceable string three times
 * with the only distinguishing fact in the extension. The names come from
 * `documentNames` (shared/documents.ts), which is also what decides how two rows
 * that would otherwise read alike are told apart — by what was last DONE to each,
 * never by the file.
 *
 * THE FILE IS STILL HERE, in the tooltip, and that is deliberate rather than a
 * leftover: "which copy is this, actually" is a real question, asked rarely, and
 * a hover is the right price for a rare question. It is one of exactly two places
 * in this app where a path is still shown to a person; the other is the OS save
 * dialog, where the thing being named really is a file.
 *
 * AN AVAILABLE DOCUMENT IS A ROW THAT IS NOT OPEN YET, and the difference from
 * an open one is deliberately quiet — the same list, the same shape, dimmed and
 * without the accent bar that means "on screen". Making it loud would turn a
 * convenience into a second inventory competing with the tabs; making it
 * invisible would be the drop-down again.
 *
 * A FILE OPENED FROM ANYWHERE ELSE stays a plain row at the bottom, ungrouped.
 * Not everything a person opens is in the library, and inventing a group for a
 * one-off PDF would be this list having an opinion about where files should
 * live.
 *
 * ── The two ✕ do not mean what they used to ─────────────────────────────────
 *
 * PEOPLE CLOSE PROJECTS, NOT DOCUMENTS. That is the model, and it reverses an
 * earlier call recorded here — that a group header should offer no close-all,
 * because the nav's idiom was one row, one ✕, naming exactly one thing. The
 * reasoning was sound about a list of documents and wrong about what a person is
 * actually doing: they finish with a BOOK. Closing its scan and leaving its
 * cast EPUB and its plain text open is not a state anybody wants, and doing
 * it three times by hand is not a gesture, it is bookkeeping.
 *
 * So the header's ✕ closes the project — every open tab belonging to it. The
 * objection that a close-all hides its own blast radius does not survive the
 * layout: the group lists its open rows directly under the button, so the count
 * is not a number to be trusted, it is a thing to be looked at. And it destroys
 * nothing — the documents are on disk and one click from coming back, which is
 * why it asks nothing first.
 *
 * THE ROW'S ✕ DELETES THAT DOCUMENT, behind the app's one confirmation. That is
 * what makes the header's job coherent: if both closed things, one of them would
 * be redundant. Every document row has it, open or merely available — the
 * earlier "nothing to close about a row that is not open" is gone, because there
 * is always something to delete. Deleting the ORIGINAL is a different question
 * and the modal asks it as one: it takes the project with it (shared/original).
 *
 * EXCEPT ON AN UNGROUPED ROW, where the ✕ still closes. A file opened from
 * outside the library is not main's to erase — `documents:delete` refuses any
 * path that is not inside a project, and it is right to. The tooltip says so
 * rather than leaving a button that behaves differently for no visible reason.
 *
 * MIDDLE-CLICK STAYS CLOSE, on every row. It is the tab-strip gesture people
 * bring with them from every other application, and every one of those closes.
 * A middle-click that deleted a file would be the most expensive muscle memory
 * in the app — and the ✕ moving jobs is exactly the reason to leave the gesture
 * that cannot destroy anything where it was.
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
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      PUT AWAY, THE PANEL IS A STUB AND NOT NOTHING. The button that collapses it
      has to be the button that brings it back, and it has to be in the same
      place — the top-left corner of the window — or collapsing the list is a
      gesture with no visible way out except a keyboard chord and a dock item
      nobody knows are there. Thirty pixels is the price.
    -->
    @if (!ui.documentsShown()) {
      <div class="stub">
        <button class="collapse" title="Show the open documents (Ctrl+B)" (click)="ui.toggleDocuments()">»</button>
      </div>
    } @else {
    <div class="panel">
      <header class="head">
        <button class="collapse" title="Hide the open documents (Ctrl+B)" (click)="ui.toggleDocuments()">«</button>
        <!-- "Open" alone read as a verb — a button you press — beside a book's
             own title in the chapter list next to it. It is a noun: these are
             the documents that are open. -->
        <span class="label">Open documents</span>
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
        @for (group of groups(); track group.key) {
          <!--
            role=group with the book's name on it, so the documents inside
            are announced as belonging to something rather than as a run of
            unrelated rows. The header itself is not focusable: it opens nothing
            and closes nothing, and a tab stop that does neither is a tab stop
            people learn to skip.
          -->
          <div class="group" role="group" [attr.aria-label]="'Project: ' + group.title">
            <div class="group-head" [title]="group.dir">
              <span class="group-name">{{ group.title }}</span>
              <!--
                Closes the BOOK — every tab open from this project. Nothing on
                disk, so no confirmation: the rows it closes are listed directly
                underneath, which is a better account of what will happen than
                any count in a warning. Hidden until the group is hovered, like
                every other ✕ in this list.
              -->
              @if (group.open > 0) {
                <button
                  class="x"
                  (click)="closeProject(group)"
                  [title]="'Close ' + group.title + ' — ' + group.open + ' open document(s)'"
                  [attr.aria-label]="'Close all ' + group.open + ' open documents in ' + group.title"
                >✕</button>
              }
            </div>
            @for (row of group.rows; track row.key) {
              <ng-container [ngTemplateOutlet]="line" [ngTemplateOutletContext]="{ $implicit: row }" />
            }
          </div>
        }

        @for (row of loose(); track row.key) {
          <ng-container [ngTemplateOutlet]="line" [ngTemplateOutletContext]="{ $implicit: row }" />
        }
      </div>

      <!--
        ONE ROW TEMPLATE FOR BOTH, because a grouped document and a loose one are
        the same thing in two places, and two copies of this markup would drift
        the first time a mark was added to one of them.
      -->
      <ng-template #line let-row>
        <div
          class="row"
          [class.child]="row.indent"
          [class.grouped]="row.grouped"
          [class.terminal]="row.terminal"
          [class.inert]="row.tab === null && row.openable === false"
          [class.on]="row.column !== null"
          [class.focused]="row.focused"
          [class.available]="row.tab === null"
          [class.before]="before() === row.key"
          [title]="row.tooltip"
          [attr.draggable]="row.tab !== null"
          (click)="pickRow(row)"
          (auxclick)="onAux($event, row.tab)"
          (contextmenu)="onMenu($event, row)"
          (dragstart)="onDragStart($event, row.tab)"
          (dragend)="onDragEnd()"
          (dragover)="onRowOver($event, row)"
          (drop)="onDrop($event, row)"
        >
          <span class="kind">{{ row.glyph }}</span>
          <span class="name">{{ row.title }}</span>
          <!--
            TWO marks, because they are two different things to fix. The dot is
            "this book is not in a folder of yours"; the pencil is "the copy
            that is in one is older than this". A row can wear both.
          -->
          @if (row.tab?.unsaved) {
            <span class="dot" title="Not saved anywhere you chose">●</span>
          }
          @if (row.tab?.modified) {
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
          <!--
            DELETES, inside a project — CLOSES, outside one. The header above
            took over closing, so this became the destructive one; but a file
            opened from outside the library is not this app's to erase, and the
            tooltip says which of the two the button is about to do rather than
            leaving it to be discovered.

            "Delete the PDF" and not "Delete Kershaw-1993.pdf": the row's name is
            what the thing IS now, so the sentence takes an article — and the
            project that "from this project" refers to is named in the header
            directly above, which is where the book is named.
          -->
          @if (row.grouped) {
            <button
              class="x danger"
              (click)="remove($event, row)"
              [title]="'Delete the ' + row.title + ' — permanently, from this project'"
              [attr.aria-label]="'Delete the ' + row.title"
            >✕</button>
          } @else if (row.tab !== null) {
            <button
              class="x"
              (click)="close($event, row.tab)"
              title="Close this document — it was opened from outside Foundry's library, so this app does not delete it"
              [attr.aria-label]="'Close ' + row.title"
            >✕</button>
          }
        </div>
      </ng-template>

      <!--
        THE MENU IS OURS, not Electron's. There is no context-menu idiom in this
        app to follow, and the native one would be the same mistake the native
        confirmation was: the OS's rectangle over a window whose every other
        surface is drawn here. It is also the only kind that can be built without
        a second IPC round trip per row.

        A full-window scrim under it, so the next click anywhere dismisses it
        exactly once and cannot also land on whatever was underneath.
      -->
      @if (menu(); as open) {
        <div class="menu-scrim" (click)="menu.set(null)" (contextmenu)="menu.set(null)"></div>
        <div
          class="menu"
          role="menu"
          [attr.aria-label]="'Actions for ' + open.row.title"
          [style.left.px]="open.x"
          [style.top.px]="open.y"
          (keydown.escape)="menu.set(null)"
        >
          <button role="menuitem" (click)="fromMenu(open.row, 'reveal')">Show in file manager</button>
          @if (open.row.tab !== null) {
            <button role="menuitem" (click)="fromMenu(open.row, 'close')">Close</button>
          }
          @if (open.row.grouped) {
            <button class="danger" role="menuitem" (click)="fromMenu(open.row, 'delete')">Delete…</button>
          }
        </div>
      }
    </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 220px;
      min-width: 220px;
      height: 100%;
    }
    /* Collapsed, the HOST narrows to the stub's width, because the shell's flex
       row measures the host and not the panel inside it — a stub drawn inside a
       220px host would be 30 pixels of button beside 190 of nothing. The class
       is put on by the shell (see App's template) rather than by a host binding
       here, so the element carrying it is invalidated by the same change
       detection pass that reads the flag. */
    :host(.shut) { width: 30px; min-width: 30px; }

    .stub {
      display: flex;
      justify-content: center;
      height: 100%;
      padding-top: 8px;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
    }

    /*
      THE TOP-LEFT CORNER OF THE WINDOW, in both states: shown, it is the first
      thing in the panel's own header; collapsed, it is the only thing in the
      stub. A collapse button that moves when you press it is a button people
      press once.
    */
    .collapse {
      flex: 0 0 auto;
      width: 20px; height: 20px;
      padding: 0;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 12px; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .collapse:hover { background: var(--bg-hover); color: var(--text-primary); }

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
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 8px 5px;
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
      THE GROUP. A hairline down the left edge is the whole of the container —
      the rows inside keep their own shape, and the rule is what says where the
      project begins and ends. Heavier chrome (a box, a fill) would make the
      panel read as two lists rather than as one list with a heading in it.
    */
    .group { margin-bottom: 2px; }
    .group-head {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 8px 3px 10px;
      color: var(--text-tertiary);
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      user-select: none;
    }
    .group-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Indented as a run, so the group's documents sit visibly inside it. The
       editor's own indent stacks on top of this, which is the nesting it means. */
    .row.grouped { padding-left: 20px; box-shadow: inset 1px 0 0 0 var(--border-subtle); }
    .row.grouped.child { padding-left: 36px; }

    /*
      AN EXPORT SITS UNDER THE DOCUMENTS, one step further in. It is a fact about
      the project the same way they are, and it is NOT one of them: a document row
      is one per type and is a base for further work, an export is terminal and
      there can be four of them. The indent is the whole of what says so — a
      second visual language for a row that behaves like every other row would be
      chrome making a distinction the gestures do not.
    */
    .row.grouped.terminal { padding-left: 32px; }

    /*
      PLAIN TEXT HAS NO TAB IN THIS APP, and the row says so by not lighting up.
      It is still listed, because it is a thing the user made and a thing they can
      reveal or delete; what it does not do is pretend a click will open it.
    */
    .row.inert { color: var(--text-tertiary); opacity: 0.65; }
    .row.inert:hover { background: transparent; color: var(--text-tertiary); }

    /*
      AVAILABLE, NOT OPEN — dimmed and nothing else. The list's existing language
      for "on screen" is the accent bar (.on / .focused), so the honest opposite
      is simply not having it: an available row is a row without the mark rather
      than a row with a mark of its own. Loud styling here would turn a
      convenience into a second inventory competing with the tabs.
    */
    .row.available { color: var(--text-tertiary); }
    .row.available:hover { color: var(--text-primary); }

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
    .group-head .x { visibility: hidden; }
    .group:hover .group-head .x, .group-head .x:focus-visible { visibility: visible; }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* The button that ends something wears the error colour on hover, and only
       on hover — the same rule Home's delete follows. A permanently red control
       on every row of a document list reads as a warning about the documents. */
    .x.danger:hover { background: var(--error-soft); color: var(--error); }

    /* Above the panel and below the dialogs; the scrim is what makes the next
       click dismiss it exactly once. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 180px;
      padding: 4px;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu button {
      display: block; width: 100%;
      padding: 6px 10px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px; text-align: left; cursor: pointer;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
    .menu button.danger:hover { background: var(--error-soft); color: var(--error); }
  `],
})
export class OpenDocumentsComponent {
  protected readonly tabs = inject(TabsService);
  protected readonly projects = inject(ProjectsService);
  /** Public to the template AND to the host binding above, which is a template too. */
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  constructor() {
    /*
     * RE-READ THE LIBRARY WHEN THE OPEN SET CHANGES, and only then.
     *
     * The two things that put a document into a project are opening one (which
     * imports it) and a conversion landing (which the queue announces by opening
     * the result). Both end as a change to the paths in this list, so watching
     * the paths catches both without this component knowing anything about
     * either. Nothing here reads `projects.items()`, so refreshing cannot
     * re-trigger the effect that asked for it.
     */
    effect(() => {
      this.tabs.tabs().map((tab) => tab.path).join('\u0000');
      void this.projects.refresh();
    });
  }

  /** The row a drop would land in front of, and whether the end of the list is the target. */
  protected readonly before = signal<string | null>(null);
  protected readonly landing = signal(false);
  /** The open context menu: which row it is about, and where it was asked for. */
  protected readonly menu = signal<{ row: Row; x: number; y: number } | null>(null);

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
      /*
       * THE COLUMN A DOCUMENT IS SHOWING IN, and showing is the word: with the
       * strips back a tab can be in a column's stack without being the one on
       * screen, and the accent bar here has always meant "you are looking at
       * this". A tab waiting in a strip is drawn as an ordinary row — its strip
       * already says where it is, and marking it on screen as well would be two
       * surfaces disagreeing about what "on screen" means.
       */
      const at = panes.findIndex((pane) => pane.activeTabId === tab.id);
      out.push({
        key: tab.id,
        tab,
        path: tab.path,
        title: tab.title,
        glyph: glyphFor(tab),
        tooltip: this.tooltip(tab),
        indent,
        grouped: false,
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

  /**
   * The open documents, gathered under the projects they came out of.
   *
   * A PROJECT IS "OPEN" WHEN ONE OF ITS DOCUMENTS IS, which is the only
   * definition that does not need a second piece of state: the group appears
   * because you opened something out of it and goes when you close the last of
   * them. Nothing here decides what a project CONTAINS — `listProjects` does
   * (electron/projects.ts), and this reads its answer, so the scan, the cast
   * book and the translation are listed by the same code that lists them
   * anywhere else.
   *
   * The order inside a group is the CATALOGUE'S, not the tabs': the live
   * document first and then what has been made from it, which is stable while
   * you open and close things. Ordering by tab would make the list reshuffle
   * itself under the pointer every time a row was clicked.
   */
  protected readonly groups = computed<Group[]>(() => {
    const open = this.rows();
    const out: Group[] = [];

    for (const project of this.projects.items()) {
      if (project.problem !== null) continue;
      const mine = open.filter((row) => fold(row.path).startsWith(`${fold(project.dir)}/`));
      if (mine.length === 0) continue;

      /*
       * THE HEADER NAMES THE BOOK, SO A ROW NAMES WHAT IT IS.
       *
       * These rows used to be FILENAMES, and every document in one project
       * shares a stem by construction (`ProjectManifest.stem`) — so under a
       * header already reading "Working Towards the Führer" the list said the
       * same string twice more, in the spelling a filesystem needs rather than
       * the one a person reads, with the only fact that differed hiding in the
       * last four characters. "PDF" and "EPUB" is the whole of what a row here
       * has left to say, and `documentNames` is where that is decided — shared,
       * so the qualifier that tells two alike rows apart is the same qualifier
       * the pickers use, and tested, so it can never quietly fall back to the
       * filename again.
       */
      const names = documentNames(project.documents);
      const nameOf = (at: number): string => names[at] ?? typeLabel(project.documents[at]!.kind);

      const rows: Row[] = [];
      const claimed = new Set<string>();
      for (const [at, document] of project.documents.entries()) {
        const already = mine.find((row) => fold(row.path) === fold(document.path));
        if (already !== undefined) {
          rows.push({ ...already, grouped: true, title: nameOf(at) });
          claimed.add(already.key);
          // An editor open on this book belongs directly under it, inside the
          // group — the same nesting the flat list gives, one level further in.
          //
          // AND IT IS CALLED "HTML" HERE AND NOWHERE ELSE. Its tab is titled
          // "<book> — HTML", which is right in the flat list where nothing else
          // names the book; inside a group the header has said the book and the
          // row above has said EPUB, so repeating both is two thirds of a row
          // spent on what the reader can already see.
          for (const row of mine) {
            if (row.indent && row.tab?.sourceTabId === already.tab?.id) {
              rows.push({ ...row, grouped: true, title: 'HTML' });
              claimed.add(row.key);
            }
          }
          continue;
        }
        /*
         * NOT OPEN, AND STILL LISTED. This is the whole point of the group: the
         * book cast from the scan you are reading is one click away, and until
         * now the only way to reach it was a screen you had to leave this one to
         * see. A missing file is listed too, plainly marked and inert — it is a
         * fact about the project, and hiding it would make a document that
         * vanished off the disk indistinguishable from one that never existed.
         */
        rows.push({
          key: `${project.key}:${document.path}`,
          tab: null,
          path: document.path,
          title: nameOf(at),
          glyph: document.kind === 'epub' ? '▤' : document.kind === 'pdf' ? '▦' : '≡',
          /*
           * AND THE FILE IS HERE, which is the other half of taking it off the
           * row. A path is the answer to a question a person asks about once a
           * month — where does this actually live, which of these is the copy my
           * sync client keeps eating — and a tooltip is exactly the right price
           * for it: free to the reader who is not asking, one hover for the one
           * who is. The lead line says what pressing the row would do, because
           * an available row's whole point is that it can be opened.
           */
          tooltip: document.missing
            ? `${document.path}\nNot there any more.`
            : document.kind === 'txt'
              ? `${document.path}\nPlain text — Foundry has no tab that reads one.`
              : `Open this ${nameOf(at)}\n${document.path}`,
          indent: false,
          grouped: true,
          missing: document.missing,
          openable: !document.missing && document.kind !== 'txt',
          // Main is what knows where a file came from, so the dot rides on the
          // document rather than being worked out from the path here.
          managed: document.managed,
          column: null,
          focused: false,
        });
      }

      /*
       * THE TERMINAL FILES — the exports, indented a step further in, under the
       * documents they were made from.
       *
       * Main sends them newest first with a PROJECT-RELATIVE path
       * (`ProjectSummary.exports`), which is this codebase's oldest house rule
       * reaching the nav: a project holds `archive/Book.pdf`, `working/Book.pdf`
       * and `final/Book.pdf` at once, so nothing may ever be matched or joined by
       * its last segment. The path is rebuilt against the project's own directory
       * — in the project's own separator, so a Windows tooltip does not read half
       * in slashes — and it is never on screen as a name.
       *
       * An export whose file has gone is not listed at all: main drops those
       * before it sends the list, because `final/` is the user's own tray and a
       * row that opens nothing is worse than no row.
       *
       * BEFORE the unclaimed sweep below, because an export that is OPEN is a tab
       * inside this project's folder and the sweep would otherwise draw it a
       * second time as "a copy you opened" — one file, two rows, one of them
       * lying about what it is.
       */
      for (const made of project.exports) {
        const path = joinIn(project.dir, made.file);
        const label = exportLabel(made.kind);
        const open = mine.find((row) => fold(row.path) === fold(path)) ?? null;
        if (open !== null) claimed.add(open.key);
        rows.push({
          key: `${project.key}:final:${made.file}`,
          tab: open?.tab ?? null,
          path,
          title: `${label} · ${exportWhen(made.madeAt)}`,
          glyph: made.kind === 'epub' ? '▤' : made.kind === 'pdf' ? '▦' : '≡',
          tooltip: made.kind === 'txt'
            ? `${path}\nPlain text — Foundry has no tab that reads one. Right-click to show it in the file manager.`
            : `Open this ${label}\nExported ${new Date(made.madeAt).toLocaleString()}\n${path}`,
          indent: false,
          grouped: true,
          terminal: true,
          // A finished thing this app made, so it wears the dot when it is opened:
          // it lives in the library and nowhere the user filed it themselves.
          managed: true,
          openable: made.kind !== 'txt',
          column: open?.column ?? null,
          focused: open?.focused ?? false,
        });
      }

      /*
       * A document open from inside the project folder that the catalogue does
       * not list — an archived copy, something a user reached by hand. It is in
       * the group because that is where it is on disk, and dropping it would be
       * a row nobody could close.
       *
       * IT SAYS WHAT MAKES IT DIFFERENT, which is that the project does not
       * claim it. Its tab is titled after the book, and under a header already
       * reading the book's name that would be a row saying nothing at all —
       * worse, a row indistinguishable from the catalogue's own row for the same
       * kind. The old answer was the filename, which is the one thing this list
       * is no longer allowed to fall back to; the honest answer is that this is
       * a copy the reader went and opened themselves, with the path one hover
       * away as always.
       */
      for (const row of mine) {
        if (claimed.has(row.key)) continue;
        const said = row.tab === null ? row.title
          : row.tab.kind === 'editor' ? 'HTML'
            : typeLabel(row.tab.kind);
        rows.push({ ...row, grouped: true, title: qualify(said, null, 'a copy you opened') });
      }

      out.push({
        key: project.key,
        title: project.title,
        dir: project.dir,
        rows,
        // What the header's ✕ would close, and what its label counts.
        open: rows.filter((row) => row.tab !== null).length,
      });
    }
    return out;
  });

  /**
   * Everything open that no group claimed — a file opened from anywhere else.
   *
   * BY TAB AND NOT ONLY BY KEY. An export row carries a key of its own
   * (`<project>:final:<file>`) rather than the tab's, because the row exists
   * whether or not anything opened it — so a group holding an OPEN export claims
   * a tab under a key this filter would never have seen, and the document would
   * be listed twice: once as the export it is, and once at the bottom of the
   * panel as a stray file from nowhere.
   */
  protected readonly loose = computed<Row[]>(() => {
    const groups = this.groups();
    const keys = new Set(groups.flatMap((group) => group.rows.map((row) => row.key)));
    const taken = new Set(groups.flatMap((group) => group.rows
      .map((row) => row.tab?.id)
      .filter((id): id is string => id !== undefined)));
    return this.rows().filter((row) => !keys.has(row.key)
      && !(row.tab !== null && taken.has(row.tab.id)));
  });

  /**
   * A document is not a route. The router still owns Settings, so clicking a row
   * from the settings screen navigates back to the workspace first — the
   * document is what a row means, and it cannot be shown on a page that is not
   * showing documents.
   */
  protected pick(tab: Tab): void {
    void this.router.navigateByUrl('/');
    this.tabs.reveal(tab.id, true);
  }

  /**
   * A click on any of the three kinds of row: reveal what is open, open what is
   * not, and do nothing at all for a file this app has no tab for.
   *
   * The first two gestures are deliberately the same one. From the user's side
   * both rows say "put this document in front of me", and whether that costs a
   * tab or merely a focus change is this app's bookkeeping, not their question.
   *
   * ── AND IT REPLACES WHAT THE COLUMN WAS SHOWING ─────────────────────────────
   *
   * *"clicking another file will automatically close the one i was looking at and
   * open the one i just clicked, unless i pin the file by right-clicking the
   * chrome-style tab at the top."* This panel is the list that ruling is about —
   * it is where somebody browses a project's faces and its exports — so the
   * `replace` flag is passed HERE and nowhere else. A drop, a finished job and a
   * step's own document all join the strip instead, because none of them is a
   * person saying "that one instead of this one".
   *
   * The displaced tab is closed through the ordinary close, so a document with
   * unsaved work still gets its question and a "keep" leaves it in the strip
   * beside the new one. A pinned one is not touched at all.
   */
  protected pickRow(row: Row): void {
    if (row.tab !== null) {
      this.pick(row.tab);
      return;
    }
    if (row.openable !== true) return;
    void this.router.navigateByUrl('/');
    void this.tabs.openFromList(row.path, row.managed === true);
  }

  /**
   * Close every tab this project has open. Nothing on disk.
   *
   * A COPY OF THE LIST FIRST, because closing mutates the very rows this is
   * iterating: `groups()` is a computed over the tabs, so reading it inside the
   * loop would be reading a list that is being emptied underneath.
   */
  protected closeProject(group: Group): void {
    const ids = group.rows.map((row) => row.tab?.id).filter((id): id is string => id !== undefined);
    for (const id of ids) void this.tabs.close(id);
  }

  /**
   * Delete the document this row names — the file, its catalogue row, and its
   * project if it turns out to be the original.
   *
   * Every branch of that is main's to decide and the modal's to ask; this hands
   * over a path and says whatever comes back.
   */
  protected async remove(event: MouseEvent, row: Row): Promise<void> {
    // Without this the click also lands on the row and opens the document that
    // is about to be deleted.
    event.stopPropagation();
    try {
      const said = await this.projects.removeDocument(row.path, () => {
        /*
         * CLOSED AFTER THE QUESTION AND BEFORE THE DELETE, which is why it is a
         * callback rather than two lines around the call. Closing first would
         * shut a document the user is about to decline to delete; closing after
         * would mean unlinking a file this window still has open — on Windows
         * the working copy is locked and the delete fails halfway. Main cannot
         * do it: tabs are the renderer's, and main's own reader is only told
         * about EPUBs.
         */
        // Without asking: see `TabsService.close`. The delete's own card is the
        // question, and it has already been answered yes. RETURNED rather than
        // voided, so the delete waits for this window to let go of the file.
        if (row.tab === null) return undefined;
        return this.tabs.close(row.tab.id, false);
      });
      if (said !== null) this.tabs.notice.set(said);
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Right-click: the same three actions the row's own controls offer. */
  protected onMenu(event: MouseEvent, row: Row): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ row, x: event.clientX, y: event.clientY });
  }

  protected fromMenu(row: Row, action: 'reveal' | 'close' | 'delete'): void {
    this.menu.set(null);
    if (action === 'reveal') {
      void api?.reveal(row.path);
      return;
    }
    if (action === 'close') {
      if (row.tab !== null) void this.tabs.close(row.tab.id);
      return;
    }
    void this.remove(new MouseEvent('click'), row);
  }

  protected close(event: MouseEvent, tab: Tab | null): void {
    if (tab === null) return;
    // Without this the click also lands on the row and reveals what is about to
    // be closed, which flashes the document on screen for one frame.
    event.stopPropagation();
    void this.tabs.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
  protected onAux(event: MouseEvent, tab: Tab | null): void {
    if (tab === null || event.button !== 1) return;
    event.preventDefault();
    void this.tabs.close(tab.id);
  }

  // ── Dragging a row ───────────────────────────────────────────────────────

  protected onDragStart(event: DragEvent, tab: Tab | null): void {
    // An available document has no tab to carry, and the workspace's drop
    // handler is written against a tab id. Nothing to drag until it is opened.
    if (tab === null) {
      event.preventDefault();
      return;
    }
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
  protected onRowOver(event: DragEvent, row: Row): void {
    if (!this.carriesDocument(event)) return;
    event.preventDefault();
    event.stopPropagation();
    /*
     * A GROUPED ROW IS NOT AN INSERTION POINT. Its order is the catalogue's, so
     * a line drawn above it would promise a move the redraw undoes a frame
     * later. `none` rather than `move` says so with the cursor, before the drop
     * — the refusal in `onDrop` is the sentence for somebody who tried anyway.
     */
    if (row.grouped) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      this.before.set(null);
      this.landing.set(false);
      return;
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const target = this.landingFor(event, row);
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
   *
   * A DOCUMENT IN A PROJECT CANNOT EITHER, and for the same reason one step out.
   * Its position is the catalogue's — the live document first, then what has
   * been made from it — and that order is redrawn from the project on every
   * change, so a reorder would be undone before the pointer was lifted. The
   * gesture that IS available to a grouped row is the one that goes somewhere
   * else: dragging it onto the workspace still puts it in a column, because the
   * workspace reads the same drag and nothing here refuses that half.
   */
  protected onDrop(event: DragEvent, row: Row | null): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Where it lands was worked out on the way in, and is READ BEFORE the drag
    // state is cleared — clearing first would drop every row at the end of the
    // list and quietly undo the insertion point the user was just shown.
    const target = this.before() ?? (row === null || row.grouped ? null : this.landingFor(event, row));
    const onto = row;
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
    if (onto?.grouped === true || this.groupedTab(moving.id)) {
      this.tabs.notice.set(
        'Documents in a project are listed in the order the project holds them, so they cannot be '
        + 'reordered here. Drag one onto a column to open it there.',
      );
      return;
    }
    // No navigation: a reorder is bookkeeping about the list, not a request to
    // look at something, so it leaves a person on Settings where they were.
    this.tabs.reorder(id, this.anchor(target));
  }

  /** Is this open tab drawn inside a project group rather than in the loose list? */
  private groupedTab(id: string): boolean {
    return this.groups().some((group) => group.rows.some((row) => row.tab?.id === id));
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

  /**
   * Which row a drop over this one lands in front of — by the half the pointer
   * is in, over the UNGROUPED list.
   *
   * The loose rows are the only ones a reorder can touch (see `onDrop`), so they
   * are the only ones this has to index into: a drop over a grouped row is
   * refused before it gets here.
   */
  private landingFor(event: DragEvent, row: Row): string | null {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (event.clientY <= box.top + box.height / 2) return row.key;
    const list = this.loose();
    const at = list.findIndex((other) => other.key === row.key);
    return list[at + 1]?.key ?? null;
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

/**
 * One drawn line of the list — a document that is open, or one that could be.
 *
 * `tab` is what separates them, and everything else is drawn the same. An open
 * row carries its tab and can be revealed, closed, dragged and reordered; an
 * available one carries only what the catalogue knows and can be opened. The two
 * share a shape so the template can share a row.
 */
interface Row {
  /** Unique in the list: the tab's id, or the project's key and the path. */
  key: string;
  /** The open tab, or null for a document the project lists and nobody opened. */
  tab: Tab | null;
  path: string;
  title: string;
  glyph: string;
  tooltip: string;
  /** True for an editor drawn under its book. */
  indent: boolean;
  /** True when the row is inside a project group, which indents the whole run. */
  grouped: boolean;
  /**
   * True for an EXPORT — a terminal file in `final/`, indented one step further
   * under the documents it was made from and never a base for anything.
   */
  terminal?: boolean;
  /** Available rows only: the file the catalogue lists is not on the disk. */
  missing?: boolean;
  /** Available rows only: false for a missing file and for `.txt`. */
  openable?: boolean;
  /** Available rows only: whether the tab it opens wears the unsaved dot. */
  managed?: boolean;
  /** 1…5 while it is on screen, counted left to right. Null when it is not. */
  column: number | null;
  /** True when that column is the focused one. */
  focused: boolean;
}

/** A project, and every document in it — open or merely available. */
interface Group {
  key: string;
  title: string;
  dir: string;
  rows: Row[];
  /** How many of those rows are actually open — what the header's ✕ closes. */
  open: number;
}

function glyphFor(tab: Tab): string {
  if (tab.kind === 'editor') return '</>';
  return tab.kind === 'epub' ? '▤' : '▦';
}

/**
 * What an export IS, in the words the export modal offered it in.
 *
 * THE PRODUCT AND NOT THE FORMAT, and certainly not the file: somebody chose
 * "Facsimile PDF" in a dialog and the row that turns up afterwards has to be
 * recognisably the thing they chose. A `pdf` under `final/` is never anything
 * else in this app — a real-text reprint is a `generated/` rendering and a step's
 * document, not an export — so the word is not a guess.
 */
function exportLabel(kind: ProjectDocumentKind): string {
  if (kind === 'epub') return 'EPUB';
  if (kind === 'txt') return 'Plain text';
  return 'Facsimile PDF';
}

/**
 * WHEN, in as few characters as a row can spare — the Steps section's rule, for
 * the Steps section's reason.
 *
 * The year is dropped for anything from this one, which is nearly every export
 * anybody looks at, and kept for the rest: two rows both reading "14 Aug" would
 * be this panel quietly claiming they were made together.
 */
function exportWhen(madeAt: number): string {
  const at = new Date(madeAt);
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A project-relative path against its project, in the project's own separator.
 *
 * Main sends `final/<name>.epub` with forward slashes whatever the platform, and
 * a Windows path spelled half one way and half the other opens perfectly well
 * and reads like a bug in the one place it is shown — the tooltip. So the joined
 * halves are made to agree rather than left to.
 */
function joinIn(dir: string, relative: string): string {
  return dir.includes('\\')
    ? `${dir.replace(/[\\/]+$/, '')}\\${relative.replace(/\//g, '\\')}`
    : `${dir.replace(/\/+$/, '')}/${relative}`;
}

/** One spelling for a path, so Windows' three become one. */
function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Ours, so a document drag and a file drag can never be mistaken for each other.
 *
 * The same type the tab strips used, kept deliberately: the workspace reads it
 * on the other end of the same gesture, and App's file-drop veil is written
 * against the fact that our drags do not carry `Files`.
 */
export const DOCUMENT_MIME = 'application/x-foundry-tab';
