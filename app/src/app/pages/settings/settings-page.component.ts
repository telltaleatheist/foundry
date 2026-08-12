import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { BackendMode, DoctorReport, EngineInfo, TierReport } from '@shared/types';

import { api } from '../../core/foundry';
import { EnvCardComponent } from './env-card.component';
import { LibraryCardComponent } from './library-card.component';
import { WslBackendComponent } from './wsl-backend.component';

/**
 * Settings — what this machine can do, and which of it to use.
 *
 * The left half is a MEASUREMENT and is read-only: `foundry doctor --json`,
 * shelled through main, rendered as one card per tier. The engine owns those
 * facts and this screen never second-guesses them — including the case where
 * the engine is too old to have the command, which is a card of its own rather
 * than an error.
 *
 * The right half is the settings FILE, whose schema the engine also owns
 * (foundry src/backend/settings.ts). This screen writes three keys and
 * preserves every other key in the file — see electron/settings.ts.
 */
@Component({
  selector: 'app-settings-page',
  imports: [EnvCardComponent, FormsModule, LibraryCardComponent, WslBackendComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <h1>Backend</h1>
        <button class="ghost" [disabled]="probing()" (click)="probe()">
          {{ probing() ? 'Probing…' : 'Re-probe' }}
        </button>
      </header>

      <section class="cols">
        <!-- ── What the engine measured ─────────────────────────────────── -->
        <div class="col">
          @if (engine(); as info) {
            <div class="engine-line">
              <span class="mono">{{ info.command }} {{ info.args.join(' ') }}</span>
              <span class="muted">{{ info.version ?? 'version unknown' }} · {{ info.source }}</span>
            </div>
          }

          @if (report(); as r) {
            <div class="card rasteriser" [attr.data-ok]="r.rasteriser.available">
              <div class="card-head">
                <span class="dot" [attr.data-ok]="r.rasteriser.available"></span>
                <span class="card-title">Rasteriser (PyMuPDF)</span>
              </div>
              <p class="detail">{{ r.rasteriser.detail }}</p>
              @if (r.rasteriser.python) {
                <p class="mono small">{{ r.rasteriser.python }}</p>
              }
            </div>

            @for (tier of r.tiers; track tier.id) {
              <div class="card" [class.chosen]="tier.id === r.chosen">
                <div class="card-head">
                  <span class="dot" [attr.data-ok]="tier.available"></span>
                  <span class="card-title">{{ title(tier) }}</span>
                  @if (tier.id === r.chosen) { <span class="badge">chosen</span> }
                </div>
                <p class="detail">{{ tier.detail }}</p>
              </div>
            }

            @if (r.chosen === null) {
              <p class="warn">
                No tier would be used: the mode names one that is not available, and the engine
                names rather than degrades — the next tier down is 10–100× slower.
              </p>
            }
          } @else if (doctorProblem(); as reason) {
            <div class="card">
              <div class="card-head">
                <span class="dot" data-ok="false"></span>
                <span class="card-title">No report</span>
              </div>
              <pre class="detail pre">{{ reason }}</pre>
            </div>
          } @else {
            <p class="muted">Probing the backends…</p>
          }
        </div>

        <!-- ── What the file says ───────────────────────────────────────── -->
        <div class="col">
          <div class="card form">
            <div class="card-head"><span class="card-title">settings.json</span></div>
            <p class="mono small">{{ settingsFile() }}</p>

            @if (settingsProblem(); as problem) {
              <p class="warn">{{ problem }}</p>
            }

            <label class="field">
              <span class="label">Mode</span>
              <select [ngModel]="mode()" (ngModelChange)="mode.set($event)" name="mode">
                <option value="auto">auto — the first available tier</option>
                <option value="endpoint">endpoint — that tier or nothing</option>
                <option value="mlx">mlx — that tier or nothing</option>
              </select>
            </label>

            <label class="field">
              <span class="label">Endpoint URL</span>
              <input type="text" placeholder="http://localhost:8000/v1"
                     [ngModel]="endpointUrl()" (ngModelChange)="endpointUrl.set($event)" name="url">
            </label>

            <label class="field">
              <span class="label">Python <em>needs PyMuPDF; every run rasterises locally</em></span>
              <input type="text" placeholder="C:\\path\\to\\python.exe"
                     [ngModel]="python()" (ngModelChange)="python.set($event)" name="python">
            </label>

            <div class="actions">
              <button class="primary" [disabled]="saving()" (click)="save()">
                {{ saving() ? 'Saving…' : 'Save' }}
              </button>
              @if (saved()) { <span class="ok-note">Saved</span> }
            </div>
            @if (saveProblem(); as problem) { <p class="warn">{{ problem }}</p> }
          </div>

          <!--
            Where the books go. Above the environment cards because it is the one
            setting on this screen that is about the user's own files rather than
            about which Python reads a page.
          -->
          <app-library-card />

          <!--
            The prebuilt Pythons. Above the WSL card on purpose: downloading the
            measured environment is now the ordinary way to get one, and building
            one with pip is the fallback for a machine that wants something else.
          -->
          <app-env-card (changed)="probe()" />

          <!--
            The one backend this app can BUILD, rather than only measure. Windows
            only: on Apple silicon the answer is MLX, and a card explaining that
            WSL is a Windows feature is noise on a machine that will never want it.
          -->
          @if (isWindows) {
            <app-wsl-backend [report]="report()" (changed)="probe()" />
          }
        </div>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow-y: auto; }
    .page { padding: 20px 24px 60px; max-width: 1100px; }

    .page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .page-head h1 { flex: 1; margin: 0; font-size: 18px; font-weight: 600; }

    .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
    @media (max-width: 900px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    .col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

    .engine-line { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; }

    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
    }
    .card.chosen { border-color: var(--accent); background: var(--accent-soft); }
    .card.form { display: flex; flex-direction: column; gap: 12px; }

    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-weight: 600; font-size: 13px; }
    .badge {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 1px 7px;
    }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); flex-shrink: 0; }
    .dot[data-ok="true"] { background: var(--ok); }

    .detail { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); word-break: break-word; }
    .pre { white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
    .mono { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
    .small { font-size: 11.5px; color: var(--text-tertiary); margin: 4px 0 0; }
    .muted { color: var(--text-tertiary); font-size: 12.5px; }
    .warn { color: var(--warn); font-size: 12.5px; margin: 0; }
    .ok-note { color: var(--ok); font-size: 12.5px; }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; opacity: 0.7; }

    .actions { display: flex; align-items: center; gap: 10px; }
    .primary {
      padding: 7px 18px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--accent); background: var(--accent-soft); color: var(--text-primary);
    }
    .primary:hover:not(:disabled) { background: var(--accent); color: #16181c; }
    .primary:disabled { opacity: 0.4; cursor: default; }
    .ghost {
      font-size: 12px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    }
    .ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-tertiary); }
    .ghost:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class SettingsPageComponent {
  protected readonly isWindows = api?.platform === 'win32';

  protected readonly report = signal<DoctorReport | null>(null);
  protected readonly doctorProblem = signal<string | null>(null);
  protected readonly probing = signal(false);
  protected readonly engine = signal<EngineInfo | null>(null);

  protected readonly settingsFile = signal('');
  protected readonly settingsProblem = signal<string | null>(null);
  protected readonly mode = signal<BackendMode>('auto');
  protected readonly endpointUrl = signal('');
  protected readonly python = signal('');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveProblem = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) {
      this.doctorProblem.set('This page is running outside Electron, so there is no engine to ask.');
      return;
    }
    this.engine.set(await api.engineInfo());
    const view = await api.settings.read();
    this.settingsFile.set(view.path);
    this.settingsProblem.set(view.problem ?? null);
    this.mode.set(view.backend.mode ?? 'auto');
    this.endpointUrl.set(view.backend.endpointUrl ?? '');
    this.python.set(view.backend.python ?? '');
    await this.probe();
  }

  protected async probe(): Promise<void> {
    if (!api) return;
    this.probing.set(true);
    try {
      // Probed at the URL ON SCREEN, not the saved one: the field is what the
      // user is asking about, and making them save first to test would make
      // every experiment a write.
      const result = await api.doctor(this.endpointUrl().trim() || undefined);
      if (result.ok) {
        this.report.set(result.report);
        this.doctorProblem.set(null);
      } else {
        this.report.set(null);
        this.doctorProblem.set(result.reason);
      }
    } finally {
      this.probing.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (!api) return;
    this.saving.set(true);
    this.saved.set(false);
    this.saveProblem.set(null);
    try {
      const view = await api.settings.write({
        mode: this.mode(),
        endpointUrl: this.endpointUrl().trim(),
        python: this.python().trim(),
      });
      this.settingsProblem.set(view.problem ?? null);
      this.saved.set(true);
      await this.probe();
    } catch (err) {
      this.saveProblem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected title(tier: TierReport): string {
    switch (tier.id) {
      case 'endpoint': return 'Endpoint (OpenAI-compatible server)';
      case 'wsl-vllm': return 'vLLM in WSL';
      case 'mlx': return 'MLX (Apple silicon)';
      case 'native': return 'Native (local, non-MLX)';
      default: return tier.id;
    }
  }
}
