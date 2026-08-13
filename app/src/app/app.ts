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
 * Ctrl/Cmd+S and Ctrl/Cmd+W are MENU items (electron/main.ts) and arrive here as
 * `menu:action`: a menu accelerator and a keydown listener for the same chord
 * both fire, and only the menu is discoverable. Ctrl/Cmd+Tab is handled here
 * because a menu item labelled "Next tab" is noise, and Escape because a dialog
 * that will not dismiss on Escape is a dialog people learn to avoid opening.
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

    // Save a copy / Close tab. Both act on the active TAB, which is renderer
    // state, so main asks rather than does.
    api?.onMenuAction((action) => {
      if (action === 'save') void this.tabs.saveActive();
      else if (action === 'save-as') void this.tabs.saveActiveAs();
      else void this.tabs.closeActive();
    });

    // The window says which document is open. The OS window list is the one
    // place a person looks when three of these are running against three books.
    effect(() => {
      const tab = this.tabs.active();
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
    // stops the browser moving focus through the rail's buttons instead.
    if (event.key === 'Tab' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.tabs.nextTab();
    }
  }

  @HostListener('window:dragenter', ['$event'])
  protected onDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth += 1;
    this.dropping.set(true);
  }

  @HostListener('window:dragover', ['$event'])
  protected onDragOver(event: DragEvent): void {
    // Without this the browser navigates the window to the dropped file, which
    // replaces the whole app with a PDF and no way back.
    event.preventDefault();
  }

  @HostListener('window:dragleave', ['$event'])
  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dropping.set(false);
  }

  @HostListener('window:drop', ['$event'])
  protected onDrop(event: DragEvent): void {
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
