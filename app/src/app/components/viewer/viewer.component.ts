import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { EpubViewComponent } from '../epub-view/epub-view.component';
import { HtmlEditorComponent } from '../html-editor/html-editor.component';
import { PdfViewComponent } from '../pdf-view/pdf-view.component';
import type { Tab } from '../../core/tabs.service';

/**
 * Whatever the tab holds, filling its pane.
 *
 * THE TAB ARRIVES AS AN INPUT rather than being read off the service, and that
 * is what makes panes possible at all: there are up to five of these on screen
 * and only one of them is showing "the active tab". A viewer that asked the
 * service which document to show would show the same one five times.
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
 * a book foundry cast is a book foundry knows the shape of. The third kind is
 * not a file at all: an `editor` tab is a book's chapter source, which lives in
 * a pane of its own so the rendered page can sit beside it.
 *
 * The empty state is Home's job now, not this component's: this only ever runs
 * with a tab, and a viewer with nothing in it is a screen the workspace does not
 * render.
 */
@Component({
  selector: 'app-viewer',
  imports: [EpubViewComponent, HtmlEditorComponent, PdfViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tab().kind === 'epub') {
      <app-epub-view [tab]="tab()" />
    } @else if (tab().kind === 'editor') {
      <app-html-editor [tab]="tab()" />
    } @else {
      <!--
        @defer, so pdf.js is its own chunk rather than half of the bundle the
        window boots with. The first screen of this app is Home, which has no
        document on it at all; loading a PDF engine to show a list of recent
        files is work done before anybody asked for it. "on immediate" means
        the fetch starts the moment a PDF tab exists — it is a file beside
        index.html, so the placeholder is a frame or two. Every pane defers
        the same chunk, which is fetched once and instantiated per pane.
      -->
      @defer (on immediate) {
        <app-pdf-view [tab]="tab()" />
      } @placeholder {
        <div class="waiting"></div>
      }
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    app-epub-view, app-pdf-view, app-html-editor { display: block; width: 100%; height: 100%; }
    .waiting { width: 100%; height: 100%; background: var(--bg-sunken); }
  `],
})
export class ViewerComponent {
  readonly tab = input.required<Tab>();
}
