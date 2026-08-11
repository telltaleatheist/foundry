import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { UiService, type ToolId } from '../../core/ui.service';

interface RailTool {
  id: ToolId;
  icon: string;
  label: string;
}

/**
 * The left rail — the tools, and the gear.
 *
 * Modelled on BookForge's nav-rail (icon over label, active state, a pinned
 * footer), minus its console-capture and service-toggle machinery, which belong
 * to that app's problems and not to this one.
 */
@Component({
  selector: 'app-tool-rail',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rail">
      <div class="rail-brand" title="Foundry">⬙</div>

      <div class="rail-tools">
        @for (tool of tools; track tool.id) {
          <button
            class="rail-item"
            [class.active]="ui.activeTool() === tool.id"
            [title]="tool.label"
            (click)="pick(tool.id)"
          >
            <span class="rail-icon">{{ tool.icon }}</span>
            <span class="rail-label">{{ tool.label }}</span>
          </button>
        }
      </div>

      <div class="rail-foot">
        <a
          class="rail-item"
          routerLink="/settings"
          routerLinkActive="active"
          title="Settings"
        >
          <span class="rail-icon">⚙</span>
          <span class="rail-label">Settings</span>
        </a>
      </div>
    </nav>
  `,
  styles: [`
    .rail {
      width: 88px;
      min-width: 88px;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-subtle);
      padding: 8px 0;
      z-index: 40;
    }

    .rail-brand {
      text-align: center;
      font-size: 20px;
      color: var(--accent);
      padding: 6px 0 12px;
    }

    .rail-tools { display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .rail-foot { border-top: 1px solid var(--border-subtle); padding-top: 8px; }

    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 10px 4px;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text-secondary);
      cursor: pointer;
      text-decoration: none;
    }
    .rail-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rail-item.active {
      background: var(--accent-soft);
      border-left-color: var(--accent);
      color: var(--text-primary);
    }

    .rail-icon { font-size: 19px; line-height: 1; }
    .rail-label { font-size: 10.5px; letter-spacing: 0.02em; text-align: center; }
  `],
})
export class ToolRailComponent {
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  // TODO: "Searchable PDF" lands here as a second output kind once the engine
  // casts one; the rail is the only thing that has to change.
  protected readonly tools: RailTool[] = [
    { id: 'ocr', icon: '⌦', label: 'OCR / Convert' },
  ];

  protected pick(tool: ToolId): void {
    // A tool is a thing you do to the open document, so picking one from the
    // settings screen takes you back to the document.
    void this.router.navigateByUrl('/');
    this.ui.toggleTool(tool);
  }
}
