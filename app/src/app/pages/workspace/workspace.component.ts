import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { OcrPanelComponent } from '../../components/ocr-panel/ocr-panel.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { DocumentService } from '../../core/document.service';
import { UiService } from '../../core/ui.service';

/**
 * The document and whatever tool is open beside it.
 *
 * The viewer takes the rest of the window in every state — a tool panel narrows
 * it, it never covers it, because the thing being configured is the document
 * you can see.
 */
@Component({
  selector: 'app-workspace',
  imports: [OcrPanelComponent, ViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="workspace">
      @if (ui.activeTool() === 'ocr') {
        <app-ocr-panel />
      }
      <div class="stage">
        <header class="doc-bar">
          <span class="doc-name">{{ doc.fileName() ?? 'Foundry' }}</span>
          <button class="ghost" (click)="doc.openViaDialog()">Open PDF…</button>
        </header>
        <app-viewer />
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .workspace { display: flex; height: 100%; }
    .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }

    .doc-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 12px;
      background: var(--bg-base);
      border-bottom: 1px solid var(--border-subtle);
    }
    .doc-name {
      flex: 1; min-width: 0;
      font-size: 12.5px; color: var(--text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ghost {
      font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    }
    .ghost:hover { color: var(--text-primary); border-color: var(--text-tertiary); }

    app-viewer { flex: 1; min-height: 0; }
  `],
})
export class WorkspaceComponent {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentService);
}
