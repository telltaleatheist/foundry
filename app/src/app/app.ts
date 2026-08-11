import { ChangeDetectionStrategy, Component, HostListener, effect, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { QueueShelfComponent } from './components/queue-shelf/queue-shelf.component';
import { ToolRailComponent } from './components/tool-rail/tool-rail.component';
import { DocumentService } from './core/document.service';
import { api } from './core/foundry';

/**
 * The shell: the rail on the left, whatever route is open in the middle, and
 * the queue shelf floating over both.
 *
 * The DROP TARGET is the whole window rather than the viewer, because a person
 * dropping a book at the app is not aiming at a rectangle — and because with an
 * <iframe> filling the centre, the PDF plugin would eat a drop aimed there.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToolRailComponent, QueueShelfComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <app-tool-rail />
      <main class="main"><router-outlet /></main>
      <app-queue-shelf />

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
      background: rgba(15, 17, 21, 0.82);
      border: 2px dashed var(--accent);
      color: var(--text-primary);
      font-size: 16px;
      pointer-events: none;
    }
  `],
})
export class App {
  private readonly doc = inject(DocumentService);
  private readonly router = inject(Router);

  protected readonly dropping = signal(false);
  private dragDepth = 0;

  constructor() {
    // The File menu's Settings item. Main cannot route; it can only say where.
    api?.onNavigate((route) => { void this.router.navigateByUrl(route); });

    // The window says which book is open. The OS window list is the one place a
    // person looks when three of these are running against three PDFs.
    effect(() => {
      const name = this.doc.fileName();
      document.title = name === null ? 'Foundry — no document open' : `${name} — Foundry`;
    });
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
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.doc.openDropped(file);
  }
}
