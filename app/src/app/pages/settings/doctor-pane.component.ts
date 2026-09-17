/**
 * doctor-pane — what Foundry needs on this computer, and the buttons that get it.
 *
 * ── THE MEASUREMENT AND THE CONTROL THAT CHOOSES BETWEEN ITS RESULTS ──────
 *
 * This page used to be two columns. `foundry doctor --json` was rendered down
 * the LEFT — one card per tier, each saying whether that backend is available —
 * and the settings.json form that SELECTS a tier sat in the RIGHT column, four
 * cards down. One question, two columns apart: a person reading "mlx — not
 * available on this platform" had no way to see, without scrolling sideways in
 * their head, that the Mode select beside it is the thing that picks between
 * exactly those cards.
 *
 * Owen, 2026-09-17, on BookForge's settings tree: *"they dont each need their
 * own tab."* The rule that produced BookForge's four sections is that a section
 * is shaped by what a person came looking for, not by which component was
 * written first. Somebody who comes here has one errand — *is anything missing,
 * and can I fix it* — so the report, the control that chooses between what it
 * reports, and the two installers are one page.
 *
 * ── THE PROBE READS THE URL ON SCREEN, NOT THE SAVED ONE ──────────────────
 *
 * Kept from the page this came from, and it is the reason Re-probe is on this
 * pane rather than on the settings shell: the field is what the person is
 * asking about, and making them save before they can test would turn every
 * experiment into a write to the engine's own file.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { BackendMode, DoctorReport, EngineInfo, TierReport } from '@shared/types';

import { api, hosted } from '../../core/foundry';
import { EnvCardComponent } from './env-card.component';
import { PageReaderCardComponent } from './page-reader-card.component';

@Component({
  selector: 'app-doctor-pane',
  imports: [EnvCardComponent, FormsModule, PageReaderCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane-head">
      @if (engine(); as info) {
        <div class="engine-line">
          <span class="mono">{{ info.command }} {{ info.args.join(' ') }}</span>
          <span class="muted">{{ info.version ?? 'version unknown' }} · {{ info.source }}</span>
        </div>
      }
      <button class="ghost" [disabled]="probing()" (click)="probe()">
        {{ probing() ? 'Probing…' : 'Re-probe' }}
      </button>
    </div>

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

    <!--
      THE ENGINE'S OWN SETTINGS, AND NOT INSIDE A HOST. settings.json is the
      engine's and machine-global, and a host runs that same engine with that
      same file — so changing the mode, the endpoint or the interpreter here
      inside BookForge would reconfigure the host's own conversions from a
      window that does not own them. settings:write refuses there too
      (electron/ipc.ts); this is the half a person sees, and it is the library
      card's rule: a control that can only refuse is not a control, so it goes.
      Found by BookForge's audit, 2026-09-14, unguarded on both sides.
    -->
    @if (!hosted()) {
      <div class="card form">
        <div class="card-head"><span class="card-title">Which tier reads a page</span></div>
        <p class="detail">
          The cards above are what this machine measured; this is which of them the engine
          will use. A run placed on a Crucible server ignores all of it — the placement names
          the reader for that run — so this is what happens when there is no placement.
        </p>
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
    }

    <!-- The prebuilt Pythons: the rasteriser every tier needs, and the
         analysis worker. Neither of them reads a page. -->
    <app-env-card (changed)="probe()" />

    <!--
      The one backend this app INSTALLS AND RUNS, rather than only measures.
      Drawn on every platform, which the WSL card it replaced could not be:
      llama.cpp has a build for Windows, for both Macs and for Linux, and the
      card says which one this machine gets. A Mac has MLX in process as well
      and does not need this — but it is offered anyway, because a Mac with no
      MLX environment installed still has to be able to read a page.
    -->
    <app-page-reader-card (changed)="probe()" />
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; }

    .pane-head { display: flex; align-items: flex-start; gap: 12px; }
    .engine-line { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }

    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
    }
    .card.chosen { border-color: var(--accent); background: var(--accent-faint); }
    .card.form { display: flex; flex-direction: column; gap: 12px; }

    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px;
    }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); flex-shrink: 0; }
    .dot[data-ok="true"] { background: var(--ok); }

    .detail { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 4px 0 0; }
    .muted { color: var(--text-tertiary); font-size: 12px; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }
    .ok-note { color: var(--ok); font-size: 12px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    select, input {
      font: inherit; font-size: 12px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 5px 7px;
    }

    .actions { display: flex; align-items: center; gap: 10px; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .primary {
      height: 32px; padding: 0 16px; border: none;
      background: var(--accent); color: var(--text-inverse);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      height: 26px; padding: 0 12px; font-size: 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class DoctorPaneComponent {
  protected readonly hosted = hosted;

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
      // Still reported by the ENGINE's doctor, which knows how to find a vLLM
      // in WSL that somebody else built. This app stopped building or starting
      // one (docs/SLOTS.md §6), so the arm stays as a label for a measurement
      // and is no longer the name of anything this screen can act on.
      case 'wsl-vllm': return 'vLLM in WSL';
      case 'mlx': return 'MLX (Apple silicon)';
      case 'native': return 'Native (local, non-MLX)';
      default: return tier.id;
    }
  }
}
