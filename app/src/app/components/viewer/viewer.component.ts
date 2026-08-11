import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import { DocumentService } from '../../core/document.service';

/**
 * The document, filling the window.
 *
 * v1 renders with CHROMIUM'S OWN PDF VIEWER: an <iframe> at a `foundry-file://`
 * URL that main serves as `application/pdf` (electron/main.ts). That buys the
 * whole toolbar — pages, zoom, search, print — for no code, and it is the thing
 * a custom pdf.js renderer would have to beat before it is worth writing.
 *
 * The URL is bypassed through the sanitizer because Angular strips any resource
 * URL on a scheme it does not recognise, and `foundry-file:` is ours by
 * construction: the renderer never builds it from anything but a path main
 * already admitted.
 */
@Component({
  selector: 'app-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (safeUrl(); as url) {
      <iframe class="page" [src]="url" title="Document"></iframe>
    } @else {
      <div class="empty">
        <div class="empty-mark">⬙</div>
        <h1>No document open</h1>
        <p>Drop a PDF anywhere in this window, or open one.</p>
        <button class="primary" (click)="doc.openViaDialog()">Open PDF…</button>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: var(--bg-sunken);
    }

    .page {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }

    .empty {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--text-tertiary);
      text-align: center;
    }
    .empty-mark { font-size: 44px; color: var(--border-default); }
    .empty h1 { margin: 0; font-size: 17px; font-weight: 600; color: var(--text-secondary); }
    .empty p { margin: 0; font-size: 13px; }

    .primary {
      margin-top: 8px;
      padding: 8px 18px;
      border-radius: 8px;
      border: 1px solid var(--accent);
      background: var(--accent-soft);
      color: var(--text-primary);
      cursor: pointer;
    }
    .primary:hover { background: var(--accent); color: #16181c; }
  `],
})
export class ViewerComponent {
  protected readonly doc = inject(DocumentService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly safeUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.doc.viewerUrl();
    return url === null ? null : this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });
}
