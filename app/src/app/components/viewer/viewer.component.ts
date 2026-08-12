import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import { EpubViewComponent } from '../epub-view/epub-view.component';
import { TabsService, type Tab } from '../../core/tabs.service';
import { api } from '../../core/foundry';

/**
 * Whatever the active tab holds, filling the window.
 *
 * A PDF renders with CHROMIUM'S OWN PDF VIEWER: an <iframe> at a
 * `foundry-file://` URL that main serves as `application/pdf`
 * (electron/main.ts). That buys the whole toolbar — pages, zoom, search, print —
 * for no code, and it is the thing a custom pdf.js renderer would have to beat
 * before it is worth writing.
 *
 * An EPUB gets app-epub-view, which is ours, because Chromium has no reader and
 * a book foundry cast is a book foundry knows the shape of.
 *
 * The empty state is Home's job now, not this component's: this only ever runs
 * with a tab, and a viewer with nothing in it is a screen the workspace does not
 * render.
 */
@Component({
  selector: 'app-viewer',
  imports: [EpubViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tabs.active(); as tab) {
      @if (tab.kind === 'epub') {
        <app-epub-view [tab]="tab" />
      } @else if (pdfUrl(); as url) {
        <iframe class="page" [src]="url" [title]="tab.title"></iframe>
      }
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    .page { width: 100%; height: 100%; border: none; display: block; }
    app-epub-view { display: block; width: 100%; height: 100%; }
  `],
})
export class ViewerComponent {
  protected readonly tabs = inject(TabsService);
  private readonly sanitizer = inject(DomSanitizer);

  /**
   * Computed off the tab's PATH, so switching tabs swaps the document and
   * switching back does not rebuild an identical URL string — Angular compares
   * the SafeResourceUrl object, and a fresh one per change detection would
   * reload the PDF and lose the reader's page.
   */
  protected readonly pdfUrl = computed<SafeResourceUrl | null>(() => {
    const tab: Tab | null = this.tabs.active();
    if (tab === null || tab.kind !== 'pdf' || !api) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(api.documentUrl(tab.path));
  });
}
