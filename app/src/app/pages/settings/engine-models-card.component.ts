/**
 * engine-models-card — which model on the engine runs each act.
 *
 * ── The ruling this card exists for ────────────────────────────────────────
 *
 * Owen, 2026-09-16 (*"the Ollama standard"*, crucible `docs/INTENT.md`):
 * Crucible should be set-and-forget like Ollama, and **all configuration happens
 * THROUGH BookForge and Foundry** rather than by interacting with Crucible
 * directly. The person's only direct contact with Crucible is the tray icon and
 * the installer.
 *
 * That REVERSES the PHASE13 ruling of 2026-09-14, which gave Crucible its own
 * operator page and deleted the model list from both apps. This card is half of
 * putting that capability back where Owen now wants it.
 *
 * ── It is a WINDOW, not a store, exactly like the card beside it ──────────
 *
 * Every value here lives in the engine's own `/v1/settings`
 * (crucible `docs/PHASE15-HOST.md` §3.1), and §5.2's rule governs: *"every
 * control in these sections is a request to the engine, and its result is the
 * engine's answer re-read. There is no Save button that writes an app file and
 * syncs later."* So there is no `AppSettings` key behind any of this, no local
 * edit buffer, and each change is one `PUT` whose ANSWER redraws the card.
 *
 * ── WHY IT IS A SECOND CARD AND NOT A COLUMN ON THE FIRST ────────────────
 *
 * `engine-settings-card` answers *where* a class runs — this machine's card, or
 * an account you connect. This answers *which model* runs it locally. They are
 * different questions with different vocabularies and, decisively, **different
 * class lists**: routing is the four llm classes (PHASE15 §1 — `pages` can never
 * go upstream), while a local model is chosen for all five acts Foundry has.
 * Putting a five-row control inside a four-row table would mean one row with an
 * empty half and a reader wondering what it means.
 *
 * ── `null` IS A CHOICE AND IS DRAWN AS ONE ───────────────────────────────
 *
 * The SDK states it: *"null restores the engine's automatic decision"*. So the
 * first option is **Choose automatically**, a thing somebody can deliberately
 * pick and come back to — not a blank that reads as "unset". Nothing here treats
 * a null assignment as a gap to fill in.
 *
 * ── AND THE FIT FIGURE IS AN ESTIMATE, SAID OUT LOUD ─────────────────────
 *
 * `LocalModelChoice.fits` excludes the KV cache (see that type's own note, which
 * carries the measured numbers). A model can report that it fits and then fail
 * to load. This card therefore never writes "will fit"; it prints the engine's
 * estimate, labels it one, and says what it leaves out. The underlying defect is
 * Crucible's and is Owen's to rule on — papering over it here with a margin of
 * this app's invention would hide the evidence that argument needs.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { defaultEngineServer, type LocalModelChoice, type SettingsDocument } from '@shared/engine-settings';
import type { CrucibleServerView } from '@shared/slots';
import { MODEL_CLASSES, type ModelClass } from '@shared/types';
import { actWords, sizeWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';

/**
 * The reserved value of the "let the engine decide" option.
 *
 * It cannot collide with a model id, which is why it is not the empty string: a
 * select whose "none" value is `''` cannot tell "nobody picked" from "picked the
 * automatic one", and those are the two states this control exists to separate.
 */
const AUTOMATIC = 'automatic-choice';

@Component({
  selector: 'app-engine-models-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servers().length > 0) {
      <div class="card">
        <div class="card-head">
          <span class="card-title">Which model runs each act</span>
          @if (working()) { <span class="small">working…</span> }
        </div>

        <p class="detail">
          Chosen on the GPU engine, not here — this is a window onto its own settings, and
          BookForge shows the same answers. Leave an act on Choose automatically and the engine
          picks for itself.
        </p>

        @if (servers().length > 1) {
          <label class="field">
            <span class="label">Engine</span>
            <select [ngModel]="chosen()" name="models-engine" (ngModelChange)="choose($event)">
              @for (server of servers(); track server.name) {
                <option [value]="server.name">{{ server.name }}</option>
              }
            </select>
          </label>
        }

        @if (problem(); as why) { <p class="warn">{{ why }}</p> }

        @if (support(); as local) {
          @if (local.supported) {
            @for (row of rows(); track row.cls) {
              <div class="act">
                <span class="who">{{ row.act }}</span>
                <select class="wide" [name]="'m-' + row.cls"
                        [disabled]="working()"
                        [ngModel]="row.selected"
                        (ngModelChange)="assign(row.cls, $event)">
                  <option [value]="automatic">Choose automatically</option>
                  @for (choice of row.choices; track choice.id) {
                    <option [value]="choice.id">{{ optionLabel(choice) }}</option>
                  }
                </select>
              </div>
              @if (row.choices.length === 0) {
                <p class="small">
                  This engine offers no model for {{ row.act.toLowerCase() }}.
                </p>
              }
            }

            <!--
              SAID ONCE, UNDER THE WHOLE TABLE, rather than beside every row.
              It is one fact about every figure above, and repeating it five
              times would make it read as a per-model caveat rather than as the
              property of the measurement that it is.
            -->
            <p class="small">
              The sizes are the engine's estimate of the WEIGHTS only — they do not include the
              KV cache, which a long context on a large model adds several gigabytes to. A model
              can be offered as fitting and still run out of memory when it loads.
            </p>
          } @else {
            <!--
              A FACT ABOUT THE SERVER, NOT AN EMPTY STATE. The document carried
              neither field, which means this engine predates model assignment —
              so the card says which engine and what to do, rather than drawing a
              picker with nothing in it.
            -->
            <p class="small">
              This engine is older than per-act model choice, so it decides for itself and there
              is nothing here to set. Updating Crucible on that machine adds it.
            </p>
          }
        }
      </div>
    }
  `,
  styles: `
    .card {
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head { display: flex; align-items: baseline; gap: 10px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }
    .detail { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .small { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .warn { margin: 0; font-size: 12px; color: var(--error); }
    .field { display: flex; align-items: center; gap: 8px; }
    .label { font-size: 11px; color: var(--text-tertiary); }
    .act { display: flex; align-items: center; gap: 10px; }
    .who { font-size: 12px; color: var(--text-primary); min-width: 160px; }
    select {
      font: inherit;
      font-size: 12px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 4px 6px;
    }
    select.wide { flex: 1; min-width: 0; }
  `,
})
export class EngineModelsCardComponent {
  protected readonly automatic = AUTOMATIC;
  protected readonly servers = signal<CrucibleServerView[]>([]);
  protected readonly chosen = signal('');
  protected readonly doc = signal<SettingsDocument | null>(null);
  protected readonly working = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly support = computed(() => this.doc()?.localModels ?? null);

  /**
   * One row per act, in {@link MODEL_CLASSES} order.
   *
   * A class the engine serves that Foundry has no act for — `tts`, `asr`,
   * `align`, `rvc`, `denoise`, all BookForge's — is not drawn, on the same rule
   * the engine step's capability table follows: a Foundry settings page listing
   * a voice engine is the noise Owen objected to, in the other direction.
   */
  protected readonly rows = computed(() => {
    const local = this.support();
    if (local === null || !local.supported) return [];
    return MODEL_CLASSES.map((cls) => ({
      cls,
      act: actWords(cls),
      selected: local.assigned[cls] ?? AUTOMATIC,
      choices: local.choices[cls],
    }));
  });

  constructor() {
    effect(() => { void this.load(); }, { allowSignalWrites: true });
  }

  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    if (this.chosen().length === 0) {
      this.chosen.set(defaultEngineServer(view.servers)?.name ?? '');
    }
    if (this.chosen().length > 0) await this.read();
  }

  /** One read. A failure is DRAWN and the document cleared — never swallowed. */
  private async read(): Promise<void> {
    if (!api) return;
    this.working.set(true);
    try {
      this.doc.set(await api.crucible.engineSettings(this.chosen()));
      this.problem.set(null);
    } catch (err) {
      this.doc.set(null);
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.working.set(false);
    }
  }

  protected choose(name: string): void {
    this.chosen.set(name);
    void this.read();
  }

  /**
   * "qwen3.8-27b-4bit — 20.1 GB, installed" — and the word for the figure is
   * never "fits".
   *
   * A model the engine says does NOT fit is still LISTED and still selectable.
   * Three reasons, and the third is the one that decides it: the estimate
   * excludes the KV cache and is therefore not a verdict; a person may be about
   * to free memory or change the desktop allowance; and **the engine refuses by
   * name** (`local_model_does_not_fit`, 409). A picker that hid the row would be
   * this app enforcing a rule it holds a worse copy of, and the person would be
   * left wondering where the model went.
   */
  protected optionLabel(choice: LocalModelChoice): string {
    const size = sizeWords(choice.memoryBytesEstimate);
    const room = choice.fits ? `${size} est.` : `${size} est., larger than this card`;
    return `${choice.id} — ${room}${choice.installed ? '' : ', not installed'}`;
  }

  /**
   * ONE PRESS, ONE PUT, AND THE ANSWER REDRAWS.
   *
   * The engine's refusals are the ones a person sees — `local_model_unknown`,
   * `local_model_not_selectable`, `local_model_does_not_fit`,
   * `capability_undecided` — printed as they arrive. Nothing is validated here
   * first: this app's copy of what the engine will accept is necessarily worse
   * than the engine's, and a refusal it pre-empted wrongly is a control that
   * does nothing with no sentence to explain it.
   */
  protected async assign(cls: ModelClass, value: string): Promise<void> {
    if (!api || this.working()) return;
    this.working.set(true);
    try {
      const model = value === AUTOMATIC ? null : value;
      this.doc.set(await api.crucible.engineSettingsPut(this.chosen(), {
        localModels: { [cls]: model },
      }));
      this.problem.set(null);
    } catch (err) {
      /*
       * THE DOCUMENT IS RE-READ RATHER THAN LEFT AS IT WAS. A refusal applies
       * nothing (§3.2), so the engine still holds what it held — but the SELECT
       * is now showing the value the person picked, which the engine rejected.
       * Re-reading is what puts the control back in step with the machine.
       */
      this.problem.set(err instanceof Error ? err.message : String(err));
      await this.read();
    } finally {
      this.working.set(false);
    }
  }
}
