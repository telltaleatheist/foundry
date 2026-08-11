import { Injectable, computed, signal } from '@angular/core';

import { api } from './foundry';

/**
 * Which PDF is open — the one fact the viewer, the OCR panel and the title bar
 * all read. It lives in a service rather than in the workspace component so a
 * trip to Settings and back does not close the document.
 */
@Injectable({ providedIn: 'root' })
export class DocumentService {
  private readonly path = signal<string | null>(null);

  readonly openPath = this.path.asReadonly();

  readonly fileName = computed(() => {
    const p = this.path();
    if (!p) return null;
    return p.split(/[\\/]/).pop() ?? p;
  });

  /** What the viewer's <iframe> points at. Null when nothing is open. */
  readonly viewerUrl = computed(() => {
    const p = this.path();
    return p && api ? api.documentUrl(p) : null;
  });

  constructor() {
    api?.onDocumentOpened((absolutePath) => this.path.set(absolutePath));
  }

  /** The toolbar's Open button. The menu's File→Open arrives on the event above. */
  async openViaDialog(): Promise<void> {
    if (!api) return;
    const chosen = await api.openPdfDialog();
    if (chosen) this.path.set(chosen);
  }

  /**
   * A drop. Main decides whether the path is openable; a refusal (not a PDF, or
   * gone) leaves the current document alone rather than blanking the viewer.
   */
  async openDropped(file: File): Promise<void> {
    if (!api) return;
    const candidate = api.pathForFile(file);
    if (!candidate) return;
    const admitted = await api.openPath(candidate);
    if (admitted) this.path.set(admitted);
  }
}
