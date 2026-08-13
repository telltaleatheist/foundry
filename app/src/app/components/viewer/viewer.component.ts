import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { EpubViewComponent } from '../epub-view/epub-view.component';
import { PdfViewComponent } from '../pdf-view/pdf-view.component';
import { TabsService } from '../../core/tabs.service';

/**
 * Whatever the active tab holds, filling the window.
 *
 * A PDF USED TO RENDER IN CHROMIUM'S OWN VIEWER — an <iframe> at a
 * `foundry-file://` URL served as `application/pdf` — which bought the whole
 * toolbar for no code and was, for as long as it lasted, the thing a custom
 * pdf.js renderer would have to beat before it was worth writing. Two needs
 * beat it, and both are about this app in particular rather than about taste:
 *
 *   THE THUMBNAIL RAIL. Chromium's sits on the left, takes a column of a window
 *   whose entire job is showing a page, and cannot be moved, restyled, narrowed
 *   or turned off from outside the plugin — there is no API and no setting. The
 *   strip in app-pdf-view runs along the bottom and starts hidden.
 *
 *   THE TEXT LAYER. What foundry adds to a PDF is text in rendering mode 3, and
 *   the one thing Chromium's viewer is built never to do is draw it. So a
 *   conversion that put the layer half a page off looks exactly like one that
 *   got it right, and the only way to tell was to search and guess at what a
 *   miss meant. app-pdf-view can show the layer beside the page.
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
  imports: [EpubViewComponent, PdfViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tabs.active(); as tab) {
      @if (tab.kind === 'epub') {
        <app-epub-view [tab]="tab" />
      } @else {
        <!--
          @defer, so pdf.js is its own chunk rather than half of the bundle the
          window boots with. The first screen of this app is Home, which has no
          document on it at all; loading a PDF engine to show a list of recent
          files is work done before anybody asked for it. "on immediate" means
          the fetch starts the moment a PDF tab exists — it is a file beside
          index.html, so the placeholder is a frame or two.
        -->
        @defer (on immediate) {
          <app-pdf-view [tab]="tab" />
        } @placeholder {
          <div class="waiting"></div>
        }
      }
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    app-epub-view, app-pdf-view { display: block; width: 100%; height: 100%; }
    .waiting { width: 100%; height: 100%; background: var(--bg-sunken); }
  `],
})
export class ViewerComponent {
  protected readonly tabs = inject(TabsService);
}
