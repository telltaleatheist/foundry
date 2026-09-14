/**
 * machine-models-card — every store of weights on this machine, with sizes.
 *
 * ── WHY A ROW THAT MOSTLY CANNOT DO ANYTHING ────────────────────────────────
 *
 * docs/SLOTS.md §5b, Owen: *"id really rather not have multiple copies of
 * gigantic models floating around."* They cannot be shared — ollama holds
 * quantised GGUF blobs, a Crucible on WSL holds safetensors for vLLM, a Crucible
 * on a Mac holds MLX weights, and the 27B in each is a different file — so the
 * only thing this screen can honestly do about duplication is SHOW it. §5b's
 * last bullet asks for exactly that: *"a 'Models on this machine' settings row
 * lists every store the app knows… with sizes, so duplication is seen rather
 * than discovered from a full disk."*
 *
 * ── ONE REMOVE BUTTON, ON THE ONE STORE FOUNDRY OWNS ────────────────────────
 *
 * Foundry's own downloads — the llama.cpp build and the two dots.ocr GGUF files
 * — are the only things this app put on the disk, so they are the only things it
 * offers to take off. Ollama's list is drawn beside them with NO button at all:
 * Owen, *"ollama has its own thing going on and we should leave it be"*, and a
 * Remove here would be this app reaching into another program's store to make a
 * number on a screen smaller.
 *
 * THE REMOVAL SAYS WHAT IT FREED, always, and the sentence comes from main
 * (`RemovalOutcome.detail`) rather than being composed here from the number:
 * main is what knows whether the directory could be measured before it went, and
 * a card inventing "freed 0 GB" over an unmeasurable one would be worse than the
 * truth, which is that it could not say.
 *
 * ── AND A CRUCIBLE LINE THAT CURRENTLY SAYS THERE IS NONE ───────────────────
 *
 * The third store is a local Crucible's residency. It is drawn, it is empty, and
 * its sentence says the registry has not landed — package C (docs/SLOTS.md §6).
 * Drawing the empty row now rather than hiding it is the same decision the rest
 * of this screen makes about an absent tier: a store nobody can see is a store
 * nobody knows to look for.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { MachineModels } from '@shared/types';

import { api } from '../../core/foundry';

@Component({
  selector: 'app-machine-models-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <header class="head">
        <h2>Models on this machine</h2>
        @if (inventory(); as it) {
          <span class="pill">{{ total(it) }}</span>
        }
      </header>

      @if (inventory(); as it) {
        @for (store of it.stores; track store.id) {
          <div class="store">
            <div class="store-head">
              <span class="store-name">{{ store.label }}</span>
              @if (store.bytes !== null && store.items.length > 0) {
                <span class="small mono">{{ size(store.bytes) }}</span>
              }
            </div>
            <p class="detail">{{ store.detail }}</p>

            @if (store.items.length > 0) {
              <ul class="files">
                @for (item of store.items; track item.name) {
                  <li>
                    <span class="name mono">{{ item.name }}</span>
                    <span class="small mono">
                      @if (item.bytes !== null) { {{ size(item.bytes) }} } @else { size unknown }
                    </span>
                    <span class="small">{{ item.detail }}</span>
                  </li>
                }
              </ul>
            }

            <!--
              THE ONLY BUTTON ON THIS CARD, and only on the store this app wrote.
              \`removable\` is main's answer and not a guess made here: it is false
              for Ollama by rule and false for Foundry's own store when there is
              nothing in it to remove.
            -->
            @if (store.removable) {
              <div class="actions">
                <button class="ghost danger" [disabled]="busy()" (click)="remove()">
                  {{ busy() ? 'Removing…' : 'Remove Foundry\\'s downloads' }}
                </button>
                <span class="small">Installing the page reader again downloads them back.</span>
              </div>
            }
          </div>
        }

        @if (said(); as sentence) { <p class="detail">{{ sentence }}</p> }

        <p class="small mono">Catalog: {{ it.generatedBy }} · {{ it.generatedAt }}</p>
      } @else {
        <p class="detail">Measuring…</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .head { display: flex; align-items: center; gap: 8px; }
    .head h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }
    .pill {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      background: var(--bg-input); color: var(--text-secondary);
    }

    .store { display: flex; flex-direction: column; gap: 6px; }
    .store + .store { border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .store-head { display: flex; align-items: baseline; gap: 8px; }
    .store-name { font-size: 12px; font-weight: 600; }

    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); }
    .mono { font-family: var(--font-mono); word-break: break-word; }

    .files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .files li { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    .files .name { min-width: 0; }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .danger { color: var(--warn); }
  `],
})
export class MachineModelsCardComponent {
  protected readonly inventory = signal<MachineModels | null>(null);
  protected readonly busy = signal(false);
  /** What the last removal did, in main's own words. Null until one happens. */
  protected readonly said = signal<string | null>(null);

  constructor() {
    if (!api) return;
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    this.inventory.set(await api.models.inventory());
  }

  /**
   * Remove Foundry's own downloads, then re-measure.
   *
   * THE SENTENCE IS MAIN'S AND THE NUMBER IS IN IT. The card does not compose
   * "freed 3.2 GB" from `freedBytes`, because main is the only thing that knows
   * whether the directory could be measured before it went — and an unmeasurable
   * one has to say so rather than print a zero.
   *
   * NO CONFIRMATION CARD, and that is a judgement rather than an oversight: what
   * this deletes is re-downloadable from its published source, the button says
   * so beside itself, and the app already reserves the confirm-and-name-it
   * gesture for the one deletion that is irreversible (`capture:remove`, the
   * photographs).
   */
  protected async remove(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    try {
      const outcome = await api.models.removePageReader();
      this.said.set(outcome.detail);
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** Every store's bytes added up, or a sentence when any of them is unknown. */
  protected total(inventory: MachineModels): string {
    let sum = 0;
    for (const store of inventory.stores) {
      if (store.items.length === 0) continue;
      if (store.bytes === null) return 'size partly unknown';
      sum += store.bytes;
    }
    return sum === 0 ? 'nothing here yet' : this.size(sum);
  }

  /** `page-reader-card`'s own scale, so two cards on one screen agree. */
  protected size(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }
}
