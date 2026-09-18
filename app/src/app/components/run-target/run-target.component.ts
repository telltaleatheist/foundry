/**
 * run-target — which engine this act will run on, and what will run it.
 *
 * ── THE ONE CHOICE, AND THE THING THAT IS NOT A CHOICE ────────────────────
 *
 * Owen, 2026-09-17, on opening OCR and meeting a dialog written before Crucible
 * existed: *"we need to fix all modals to use the chosen crucible server. let
 * the user pick which crucible server to use in the modal."* And on how to draw
 * it: *"if there's only one model, it just lists the model itll use. it doesnt
 * ask the user to pick from a one-item list … if an option is impossible to
 * click, like 'en', or it's already chosen or something, dont present it as an
 * option. it isnt an option. present it as information or dont present it at
 * all."*
 *
 * So this component draws exactly two things and knows the difference between
 * them:
 *
 *   * **THE SERVER IS A CHOICE** — but only when there is more than one, and
 *     only then is it drawn as something to press. `Job.waitFor` has always been
 *     the per-job slot pin, so choosing here is a field on the request the queue
 *     already honours rather than new machinery.
 *   * **THE MODEL IS INFORMATION.** It was going to be buttons. It is not,
 *     because there is no per-run model override in the contract: for a Crucible
 *     act the model comes from that engine's own capability record, chosen by
 *     the class setting. Buttons here would have had to write the ENGINE's
 *     setting — a global effect from a local-looking control, changing what
 *     every future run on that server uses. Owen, told that: *"if theres no
 *     per-model override then scrap it. just let the user move forward. it isnt
 *     an option they can pick, it just tells them whats happening."*
 *
 * That second rule is the load-bearing one and it is why this file is small. A
 * control that cannot change anything is not a control, and dressing a fact up
 * as one teaches somebody that they chose something they did not.
 *
 * ── AND WHEN THE ACT CANNOT RUN AT ALL, IT SAYS SO HERE ──────────────────
 *
 * The engine's own sentence, not one composed here: a host-mode Crucible with no
 * WSL2 says it cannot serve the class, and a Mac says `dots-ocr` declares no
 * `mlx-darwin` build. {@link ready} carries that verdict out to the dialog so the
 * Start button is off rather than offering a press that ends in a refusal.
 */
import {
  ChangeDetectionStrategy, Component, computed, effect, input, model, output, signal,
} from '@angular/core';

import type { CapabilityRecord } from '@shared/engine-settings';
import { defaultEngineServer } from '@shared/engine-settings';
import type { CrucibleServerView } from '@shared/slots';
import type { ModelClass } from '@shared/types';

/**
 * WHAT EACH ACT IS CALLED when telling somebody a machine cannot do it.
 *
 * Deliberately not `actWords` (core/crucible-words.ts), whose phrasings are
 * NOUNS for a settings row — "Read the pages of a scan", "Analyse claims". These
 * are verb phrases that have to finish the sentence *"X cannot …"*, and a table
 * that tried to serve both would serve one of them badly.
 */
const ACT_WORDS: Readonly<Record<string, string>> = {
  pages: 'read pages',
  clean: 'clean up text',
  translate: 'translate',
  simplify: 'simplify',
  analysis: 'analyse',
};
import { api } from '../../core/foundry';

@Component({
  selector: 'app-run-target',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servers().length === 0) {
      <!--
        NOT A PICKER WITH NOTHING IN IT. Owen, 2026-09-15: "if theres no
        connected crucible server then tiles should be disabled" -- and the same
        rule one screen in. The dialog's Start is off (ready is false), so this
        says what is missing rather than offering a press that cannot work.
      -->
      <p class="none">
        No Crucible server is connected, and every page is read on one. Add an engine under
        Settings › Crucible Servers and this fills itself in.
      </p>
    } @else {
      <div class="target">
        @if (servers().length > 1) {
          <!--
            A CHOICE, so it is drawn as one. Chips rather than a dropdown: Owen,
            "i would prefer to avoid dropdowns if i can, theyre ugly."
          -->
          <div class="chips">
            @for (entry of servers(); track entry.name) {
              <button class="chip" type="button"
                      [class.chosen]="entry.name === server()"
                      (click)="server.set(entry.name)">
                <span class="tick">{{ entry.name === server() ? '✓' : '' }}</span>
                <span class="chip-name">{{ entry.name }}</span>
              </button>
            }
          </div>
        }

        <!--
          ── TWO LINES WHEN IT CANNOT RUN, AND THE ORDER MATTERS ─────────────

          It was one line carrying the engine's own reason verbatim, on the
          rule act-gates follows: a server says things this app could not have
          composed, so do not reword them. That rule is right about a reason
          somebody can ACT on and wrong about this one. Owen, picking the Mac for
          an OCR, got:

              disabled: reading page images (the VLM door) needs page readers,
              and this build ships none with a mlx-darwin block

          Every clause of which is true and three of them are Crucible's
          internals — a door, a build, a manifest block. It also opens with a
          LABEL ("disabled:") rather than a sentence.

          So the first line is this app's, in the words of what it means to the
          person: this machine cannot do this. The engine's own sentence stays,
          underneath and quieter, because it is still the only thing that says
          WHY and somebody diagnosing it needs exactly those words. Nothing is
          discarded and nothing is reworded; the two are put in the order a
          person reads them in.
        -->
        @if (runnable()) {
          <p class="says">{{ says() }}</p>
        } @else {
          <p class="says warn">{{ cannot() }}</p>
          @if (reason(); as why) { <p class="because">{{ why }}</p> }
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    .none { margin: 0; font-size: 12px; line-height: 1.5; color: var(--warn); }

    .target { display: flex; flex-direction: column; gap: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }

    /* Selected is a tick and a border; the text never changes colour against its
       background. A sibling of this control shipped as text on a solid accent
       and could not be read. */
    .chip {
      display: inline-flex; align-items: baseline; gap: 6px;
      font: inherit; font-size: 12px;
      background: var(--bg-sunken); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 4px 10px; cursor: pointer;
    }
    .chip:hover { border-color: var(--text-tertiary); }
    .chip.chosen { border-color: var(--accent); }
    .tick { font-size: 10px; color: var(--accent); width: 8px; flex: none; }

    .says { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .says.warn { color: var(--warn); }
    /* The engine's own words: kept, and quieter than the sentence above them. */
    .because {
      margin: 0; font-size: 11px; line-height: 1.5;
      color: var(--text-muted); font-style: italic;
    }
  `],
})
export class RunTargetComponent {
  /** Which act this dialog is about — the engine's own class name. */
  readonly act = input.required<ModelClass>();

  /** The chosen engine's name. Two-way: the dialog puts it on the request. */
  readonly server = model<string>('');

  /**
   * MAY THIS ACT BE STARTED AT ALL on the chosen engine.
   *
   * An output rather than something the dialog re-derives, because the answer
   * costs a network read and the dialog would otherwise be making a second one
   * to learn what this component already knows.
   */
  readonly ready = output<boolean>();

  protected readonly servers = signal<CrucibleServerView[]>([]);
  private readonly capability = signal<CapabilityRecord | null>(null);
  private readonly problem = signal<string | null>(null);

  /** The row for this act on the chosen engine, once its capability is read. */
  private readonly row = computed(() => {
    const record = this.capability();
    if (record === null) return null;
    return record.classes.find((entry) => entry.capability === this.act()) ?? null;
  });

  protected readonly runnable = computed(() => {
    if (this.servers().length === 0) return false;
    const row = this.row();
    // Unread is not refused: a capability that has not answered yet must not
    // dark the button, or every dialog opens disabled for a moment and a person
    // presses nothing because it looked broken.
    return row === null ? this.problem() === null : row.enabled;
  });

  /**
   * THE SENTENCE UNDER THE CHIPS, and every arm of it is a fact rather than an
   * offer.
   *
   * The engine's own `reason` is used verbatim when it will not serve the class,
   * for the reason act-gates gives: a host-mode Crucible and a Mac with no
   * `mlx-darwin` build each say something this app could not have composed, and
   * both say what to do about it.
   */
  protected readonly says = computed(() => {
    const chosen = this.server();
    const where = this.servers().length > 1 ? '' : `${chosen} · `;
    if (this.problem() !== null) return `${where}could not be asked what it runs: ${this.problem()}`;
    const row = this.row();
    if (row === null) return `${where}asking what it runs…`;
    const model = row.selected.length > 0 ? row.selected : 'a model it chooses itself';
    return `${where}runs on ${model}`;
  });

  /** What a refusal MEANS, in this app's words. See the template's note. */
  protected readonly cannot = computed(() => {
    const chosen = this.server();
    const named = chosen.length > 0 ? `"${chosen}"` : 'That engine';
    if (this.problem() !== null) return `${named} could not be asked what it can do.`;
    return `${named} cannot ${ACT_WORDS[this.act()] ?? 'run this'} — choose another engine.`;
  });

  /**
   * The engine's own sentence, kept verbatim except for a leading LABEL.
   *
   * `disabled:` is not part of the explanation; it is the field's name leaking
   * into its value, and it reads as the first word of a sentence that then does
   * not parse. Stripping a known prefix is not rewording — every word the server
   * wrote about WHY survives.
   */
  protected readonly reason = computed(() => {
    if (this.problem() !== null) return this.problem();
    const row = this.row();
    if (row === null || row.enabled) return null;
    const said = row.reason.trim();
    const cut = said.toLowerCase().startsWith('disabled:') ? said.slice('disabled:'.length) : said;
    const trimmed = cut.trim();
    return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : null;
  });

  constructor() {
    void this.load();
    // The chosen engine changed, so everything said about it is about the wrong
    // machine until the next read lands.
    effect(() => {
      const name = this.server();
      if (name.length === 0) return;
      void this.readCapability(name);
    });
    effect(() => { this.ready.emit(this.runnable()); });
  }

  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    if (this.server().length === 0) {
      /*
       * THE LOOPBACK ENGINE FIRST — Owen: "pre-selects the local model if it's
       * available". `defaultEngineServer` is that rule, already written for the
       * settings window: loopback-and-enabled, then the first enabled, then the
       * first at all. One owner rather than a second copy that drifts.
       */
      this.server.set(defaultEngineServer(view.servers)?.name ?? '');
    }
  }

  private async readCapability(name: string): Promise<void> {
    if (!api) return;
    this.capability.set(null);
    this.problem.set(null);
    try {
      this.capability.set(await api.crucible.engineCapability(name));
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }
}
