import { Injectable, signal } from '@angular/core';

/** Which tool the left rail has open, and whether the shelf is unrolled. */
export type ToolId = 'ocr';

@Injectable({ providedIn: 'root' })
export class UiService {
  readonly activeTool = signal<ToolId | null>(null);
  readonly shelfExpanded = signal(false);

  toggleTool(tool: ToolId): void {
    this.activeTool.update((current) => (current === tool ? null : tool));
  }

  closeTool(): void {
    this.activeTool.set(null);
  }
}
