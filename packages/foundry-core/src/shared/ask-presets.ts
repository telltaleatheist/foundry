/**
 * ASK'S PRESETS — questions the person keeps, each a title and the text sent to
 * the model when it is pressed (Owen, 2026-11-02; made the person's own,
 * 2026-11-10).
 *
 * EVERY PRESET IS ONE THE PERSON WROTE. Four used to ship in this file; Owen,
 * 2026-11-10: *"i think we should create 'ask' presets instead of having the
 * presets coded in"*, then *"remove the shipped defaults"*. A list nobody has
 * added to is empty, and there is nothing to restore.
 *
 * The presets are the APP's, not a book's: the same jobs are asked of every
 * book, so they live in `app-settings.json` (`askPresets`, and which were
 * checked last in `askPresetsChecked`).
 *
 * The list's order is the run order when several are sent from the Presets
 * modal. Each step is its own run on the book's thread, so each later step
 * starts from the earlier ones' note, and from the book with their changes
 * pending on it — a landing is on the pane's stack before the next step reads
 * the view (`AskChain`).
 */

/** One preset. `id` is stable across renames. */
export interface AskPreset {
  readonly id: string;
  /** Its title: the button's words. */
  readonly label: string;
  /** The text sent to the model. */
  readonly question: string;
}

/** Ceilings, so "a few buttons" stays that. */
export const ASK_PRESET_MAX = 30;
export const ASK_PRESET_LABEL_MAX = 40;
export const ASK_PRESET_QUESTION_MAX = 4000;

/** A title as kept: one line, trimmed to the ceiling. */
export function presetLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, ASK_PRESET_LABEL_MAX);
}

/** The text as kept: trimmed to the ceiling, its own line breaks left alone. */
export function presetQuestion(value: string): string {
  return value.trim().slice(0, ASK_PRESET_QUESTION_MAX);
}

/** The presets Send runs: the checked ones, in the list's order, which is the run order. */
export function checkedSteps(presets: readonly AskPreset[], checked: ReadonlySet<string>): AskPreset[] {
  return presets.filter((one) => checked.has(one.id));
}

/** Which were checked last, as stored: ids, each once. Nothing kept is none. */
export function clampCheckedPresets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
    .slice(0, ASK_PRESET_MAX);
}

/**
 * The list as stored, made legal: nothing kept is an empty list; each entry
 * needs a title and a text, trimmed to the ceilings; an id seen twice keeps
 * the first. A field this build does not know (the one-line description
 * presets carried until 2026-11-10) is not carried on.
 */
export function clampAskPresets(value: unknown): AskPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: AskPreset[] = [];
  for (const raw of value) {
    if (out.length >= ASK_PRESET_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim().slice(0, 80) : '';
    const label = typeof entry['label'] === 'string' ? presetLabel(entry['label']) : '';
    const question = typeof entry['question'] === 'string' ? presetQuestion(entry['question']) : '';
    if (id.length === 0 || label.length === 0 || question.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, question });
  }
  return out;
}

/** What the settings hold: the list, and which were checked last. */
export interface AskPresetsKept {
  readonly presets: AskPreset[];
  readonly checked: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The checked presets, as a sequence
// ─────────────────────────────────────────────────────────────────────────────

/** Which step of a chain of presets a run is, kept on its session so review can label its groups. */
export interface AskChainStep {
  /** The chain's id, shared by its steps. */
  readonly chain: string;
  /** The step's name — the button's label. */
  readonly step: string;
  /** 1-based. */
  readonly index: number;
  readonly of: number;
}

/** How one step ended, as the chain is told. */
export type AskStepEnd =
  | { readonly state: 'done' }
  | { readonly state: 'failed' | 'cancelled'; readonly message: string };

/**
 * THE PRESETS' SEQUENCE — pure, so the order, the stop on a failure and the stop
 * on a cancel are proved without a window.
 *
 * The owner (AskService) starts a step with `begin`, and tells the chain how it
 * ENDED once its marks have landed on the pane (`ended`) — not when main says
 * the model finished — which is what makes the next step read a book with the
 * earlier steps' changes pending on it. `ended` answers the next step to begin,
 * or null with the sentence the chain closes on.
 */
export class AskChain {
  private at = 0;
  private stopped: string | null = null;

  constructor(readonly id: string, readonly steps: readonly AskPreset[]) {
    if (steps.length === 0) throw new Error('Send runs at least one preset.');
  }

  /** The step to run now, with its place in the chain. */
  current(): { preset: AskPreset; step: AskChainStep } | null {
    if (this.stopped !== null || this.at >= this.steps.length) return null;
    const preset = this.steps[this.at]!;
    return { preset, step: { chain: this.id, step: preset.label, index: this.at + 1, of: this.steps.length } };
  }

  /** "Presets: step 2 of 3 — Front & back matter", or null once it is over. */
  said(): string | null {
    const now = this.current();
    return now === null ? null : `Presets: step ${now.step.index} of ${now.step.of} — ${now.step.step}`;
  }

  /** The person pressed Stop: no step after this one starts. */
  cancel(): void {
    if (this.stopped === null) this.stopped = 'cancelled';
  }

  /** A step ended. The next one to start, or the sentence the chain ends on. */
  ended(end: AskStepEnd): { next: { preset: AskPreset; step: AskChainStep } } | { over: string } {
    if (this.stopped === 'failed' || this.at >= this.steps.length) return { over: 'The presets had already stopped.' };
    // Read past a cancel: the step that was running when Stop was pressed is still the one ending.
    const now = { step: { index: this.at + 1, of: this.steps.length, step: this.steps[this.at]!.label } };
    const name = `step ${now.step.index} of ${now.step.of} (${now.step.step})`;
    if (end.state === 'failed') {
      this.stopped = 'failed';
      return { over: `The presets stopped at ${name}, which failed: ${end.message} The steps before it stay on the book.` };
    }
    if (end.state === 'cancelled' || this.stopped === 'cancelled') {
      this.stopped = 'cancelled';
      return { over: `The presets were stopped at ${name}; ${this.steps.length - now.step.index} later ${this.steps.length - now.step.index === 1 ? 'step was' : 'steps were'} not run. The steps that finished stay on the book.` };
    }
    this.at += 1;
    const next = this.current();
    return next === null ? { over: `All ${this.steps.length} presets ran.` } : { next };
  }
}
