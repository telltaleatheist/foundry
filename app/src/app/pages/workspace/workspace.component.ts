import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { HomeComponent } from '../../components/home/home.component';
import { TabStripComponent } from '../../components/tab-strip/tab-strip.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { TabsService } from '../../core/tabs.service';

/**
 * The documents: a strip of tabs, and whichever one is active under it.
 *
 * No tab active — which includes having none open at all — is HOME. Home is not
 * a route and not a tab: it is what this screen is when there is nothing to
 * show, which means closing the last tab lands somewhere useful instead of on a
 * grey rectangle.
 *
 * The strip is above the viewer and outside it, so the PDF plugin's own toolbar
 * and the app's chrome never fight for the same row.
 */
@Component({
  selector: 'app-workspace',
  imports: [HomeComponent, TabStripComponent, ViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="workspace">
      @if (tabs.tabs().length > 0) {
        <app-tab-strip />
      }
      @if (tabs.active()) {
        <app-viewer />
      } @else {
        <app-home />
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .workspace { display: flex; flex-direction: column; height: 100%; }
    app-viewer, app-home { flex: 1; min-height: 0; }
  `],
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);
}
