import { ChangeDetectionStrategy, Component, HostListener, effect, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { OcrDialogComponent } from './components/ocr-dialog/ocr-dialog.component';
import { TranslateDialogComponent } from './components/translate-dialog/translate-dialog.component';
import { QueueShelfComponent } from './components/queue-shelf/queue-shelf.component';
import { ToolRailComponent } from './components/tool-rail/tool-rail.component';
import { TabsService } from './core/tabs.service';
import { UiService } from './core/ui.service';
import { api } from './core/foundry';

/**
 * The shell: the rail on the left, whatever route is open in the middle, the
 * queue shelf floating over both, and the OCR dialog over everything.
 *
 * The DROP TARGET is the whole window rather than the viewer, because a person
 * dropping a book at the app is not aiming at a rectangle — and because with an
 * <iframe> filling the centre, the PDF plugin would eat a drop aimed there.
 *
 * ── The keyboard ─────────────────────────────────────────────────────────────
 *
 * Ctrl/Cmd+S, Ctrl/Cmd+W and Ctrl/Cmd+\ are MENU items (electron/main.ts) and
 * arrive here as `menu:action`: a menu accelerator and a keydown listener for
 * the same chord both fire, and only the menu is discoverable. Splitting is on
 * the menu for exactly that reason — with one pane open there is nothing on
 * screen that says a second is possible, so the View menu is where a person
 * finds out. Ctrl/Cmd+Tab is handled here because a menu item labelled "Next
 * tab" is noise, Ctrl/Cmd+1…5 because a menu of five "Focus pane N" items is
 * five items of noise, and Escape because a dialog that will not dismiss on
 * Escape is a dialog people learn to avoid opening.
 */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet, ToolRailComponent, QueueShelfComponent, OcrDialogComponent, TranslateDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <app-tool-rail />
      <main class="main"><router-outlet /></main>
      <app-queue-shelf />

      @if (ui.ocrOpen()) {
        <app-ocr-dialog />
      }

      @if (ui.translateOpen()) {
        <app-translate-dialog />
      }

      @if (dropping()) {
        <div class="drop-veil"><span>Drop a PDF to open it</span></div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .shell { display: flex; height: 100%; }
    .main { flex: 1; min-width: 0; height: 100%; overflow: hidden; }

    .drop-veil {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-overlay);
      backdrop-filter: blur(4px);
      border: 2px dashed var(--accent);
      color: var(--text-primary);
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 600;
      pointer-events: none;
    }
  `],
})
export class App {
  private readonly tabs = inject(TabsService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  protected readonly dropping = signal(false);
  private dragDepth = 0;

  constructor() {
    // The File menu's Settings item. Main cannot route; it can only say where.
    api?.onNavigate((route) => { void this.router.navigateByUrl(route); });

    // Save a copy / Close tab / Split right. All three act on the FOCUSED
    // pane's active tab, which is renderer state, so main asks rather than does.
    api?.onMenuAction((action) => {
      if (action === 'save') void this.tabs.saveActive();
      else if (action === 'save-as') void this.tabs.saveActiveAs();
      else if (action === 'split-right') this.tabs.splitActive();
      else void this.tabs.closeActive();
    });

    // The window says which document is open. The OS window list is the one
    // place a person looks when three of these are running against three books.
    //
    // The DOCUMENT rather than the active tab: an HTML editor is a face of its
    // book and carries neither its name nor its flags, so a window titled
    // "Bleak House — HTML" with no dot on it would be lying twice about a book
    // that has unsaved edits.
    effect(() => {
      const tab = this.tabs.activeDocument();
      if (tab === null) {
        document.title = 'Foundry';
        return;
      }
      // One bullet for either kind of "not filed away yet". The window list is a
      // glance, not a status report; the tab strip and its tooltip carry which.
      const mark = tab.unsaved || tab.modified ? ' •' : '';
      document.title = `${tab.title}${mark} — Foundry`;
    });
  }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.ui.ocrOpen()) {
      event.preventDefault();
      this.ui.closeOcr();
      return;
    }
    if (event.key === 'Escape' && this.ui.translateOpen()) {
      event.preventDefault();
      this.ui.closeTranslate();
      return;
    }
    // Ctrl+Tab. `event.key` is 'Tab' with ctrlKey, and preventDefault is what
    // stops the browser moving focus through the rail's buttons instead. It
    // cycles the FOCUSED pane's strip — a Ctrl+Tab that walked all five panes'
    // tabs in a row would move the document under a hand that meant "the next
    // one over here".
    if (event.key === 'Tab' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.tabs.nextTab();
      return;
    }
    // Ctrl+1…5 puts the focus in a column, which is what the rail, the menu and
    // Ctrl+S all follow. Shift is excluded so it cannot fire from a chord meant
    // for something else, and the guard on `panes` keeps Ctrl+3 from doing
    // anything at all in an app with two columns open.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
      && event.key >= '1' && event.key <= '5') {
      const index = Number(event.key) - 1;
      if (index < this.tabs.panes().length) {
        event.preventDefault();
        this.tabs.focusPaneAt(index);
      }
    }
  }

  /**
   * A FILE drag, and only a file drag.
   *
   * Tabs are dragged between panes with the same platform mechanism, and
   * without this test the veil ("Drop a PDF to open it") would slap itself over
   * the whole window the moment a tab left its strip. `types` is the only part
   * of a drag payload readable before the drop, which is exactly what it is for.
   */
  @HostListener('window:dragenter', ['$event'])
  protected onDragEnter(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.dropping.set(true);
  }

  @HostListener('window:dragover', ['$event'])
  protected onDragOver(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    // Without this the browser navigates the window to the dropped file, which
    // replaces the whole app with a PDF and no way back.
    event.preventDefault();
  }

  @HostListener('window:dragleave', ['$event'])
  protected onDragLeave(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dropping.set(false);
  }

  @HostListener('window:drop', ['$event'])
  protected onDrop(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.dropping.set(false);
    // Every file, not just the first: a drop of three books is three tabs, which
    // is the whole reason there are tabs.
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      void this.tabs.openDropped(file);
    }
  }
}

/** Whether a drag is carrying files from outside the app, rather than a tab. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}
