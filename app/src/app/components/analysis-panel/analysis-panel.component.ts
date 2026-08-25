import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { analysisCategoryName } from '@shared/analysis-categories';
import type { ReplayedRow } from '@shared/ops';

import { AnalysisViewService } from '../../core/analysis-view.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { byCategory, widen, type AnalysisHit, type AnalysisTier } from '../../core/analysis';

/**
 * THE HITS PANEL — what the analysis found, in the slot Compare would have had.
 *
 * Owen, 2026-08-25: *"it should light up/highlight text that matches the
 * categories, and have a list of hits in blocks on the right side, where compare
 * would normally be."* This is the right-hand side. The lighting is the paper's
 * own (`book-view.component.ts`), driven by the same signals this panel reads, so
 * the two halves of that sentence can never disagree about which passages are in.
 *
 * ── IT IS A COLUMN AND NOT A MODAL, WHICH IS THE POINT ──────────────────────
 *
 * The sweep is a card, and it CLOSES when a row travels: the point of that trip
 * is to look at the paragraph, and a modal over the page would be the one thing
 * in the way. This is a column standing beside the page, so travel closes
 * nothing — you click a chip, the paper scrolls, the row is still there, and the
 * next one is one click away. That is the whole argument for taking Compare's
 * slot rather than being a seventh dialog (docs/ANALYSIS.md §8).
 *
 * ── The three buttons are the strictness, and nothing re-runs ───────────────
 *
 * *"it flags absolutely anything that could possibly match and then we have a
 * button that displays things that match strictly (only turn up a few options), a
 * moderate filter, or a very loose filter."* The report is the same file under
 * every button; `tiered` (core/analysis.ts) is the whole of what they do, and the
 * tier is session state that is deliberately not persisted.
 *
 * ── The mechanics are the sweep's, and copied on purpose ────────────────────
 *
 * ONE HOVER LISTENER on the container rather than a pair of bindings per row: a
 * book can answer a report with hundreds of findings and only one of them can be
 * showing a widening. The row carries its own key in an attribute and the
 * container reads it back off whatever the pointer entered. The widened
 * quotation floats in a FIXED-POSITION, `pointer-events: none` glance rather than
 * swapping into the row, which is Owen's ruling from the sweep (2026-08-24) about
 * rows that grow under the hand — here it matters less (nothing on these rows is
 * a button somebody is aiming at) and it is kept anyway, because a list whose
 * rows resize while you read down them is a list that has to be re-found.
 *
 * THE GEOMETRY IS RECOMPUTED AND NOT COPIED. The sweep's glance offsets are its
 * own grid's columns spelled as numbers (14 + 120 + 10 on the left, 62 + 10 + 14
 * on the right); this panel has a different grid, so the numbers below are this
 * one's — the chip column and the padding, named where they are used so the two
 * cannot drift apart in silence.
 */
@Component({
  selector: 'app-analysis-panel',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      THE COLUMN NAMES ITSELF, exactly as the compare column does and for its
      reason: a second view with no label is two things side by side and no way to
      tell which is which.
    -->
    <header class="head">
      <span class="tag">Analysis</span>
      <span class="counts">{{ said() }}</span>
      <button
        type="button"
        class="x"
        title="Close the analysis"
        aria-label="Close the analysis"
        (click)="stage.stopAnalysis()"
      >✕</button>
    </header>

    <!--
      THE STRICTNESS, AS THREE BUTTONS AND NOT A SLIDER. They are named rather
      than numbered because the numbers are measured constants a person has no
      way to reason about (0.9 and 0.7 came out of briefcase's calibration), and
      what somebody actually wants to say is "only the certain ones" or "show me
      everything". The counts under each are what make the choice legible.
    -->
    <div class="tiers" role="group" aria-label="How strict to be">
      @for (one of tiers; track one.tier) {
        <button
          type="button"
          class="tier"
          [class.on]="analysis.tier() === one.tier"
          [title]="one.why"
          (click)="analysis.tier.set(one.tier)"
        >
          <span class="tier-name">{{ one.name }}</span>
          <span class="tier-count">{{ countFor(one.tier) }}</span>
        </button>
      }
    </div>

    @if (analysis.problem(); as reason) {
      <p class="problem">{{ reason }}</p>
    }
    @if (stale(); as caveat) {
      <p class="problem">{{ caveat }}</p>
    }

    <!--
      ONE HOVER LISTENER FOR THE WHOLE LIST, on the container. See the class
      docblock; the row carries its key and \`closest\` walks up from whatever the
      pointer actually entered. Scrolling clears it rather than letting the glance
      drift away from the row it quotes.
    -->
    <div
      class="list"
      (mouseover)="hover($event)"
      (mouseleave)="hovered.set(null)"
      (scroll)="hovered.set(null)"
    >
      @for (group of groups(); track group.category) {
        <div class="group">
          <div class="group-head">
            <span class="group-name">{{ named(group.category) }}</span>
            <span class="group-count">{{ group.hits.length }}</span>
          </div>
          @for (found of group.hits; track found.key) {
            <div
              class="row"
              [class.ghost]="found.struck"
              [class.rejected]="found.verdict === 'skip'"
              [attr.data-key]="found.key"
            >
              <!--
                THE CHIP TRAVELS. It names the block by the id every op and every
                reveal is keyed to, and pressing it puts that block in the middle
                of the page and pulses it. The panel does not close — it is a
                column, and that is the point.
              -->
              <button
                class="at"
                title="Show this block on the page"
                (click)="travel(found)"
              >
                <span class="at-id">{{ found.spans[0].id }}</span>
                @if (found.spans[0].page > 0) {
                  <span class="at-page">≈ {{ found.spans[0].page }}</span>
                }
                @if (found.spans.length > 1) {
                  <span class="at-page">{{ found.spans.length }} blocks</span>
                }
              </button>

              <!-- The row's quotation NEVER changes: the fuller text floats in
                   the glance below, so no row grows under the pointer. -->
              <p class="quote">
                <span class="q-before">{{ found.quote.before }}</span><span
                  class="q-hit"
                >{{ found.quote.hit }}</span><span class="q-after">{{ found.quote.after }}</span>
              </p>

              <div class="marks">
                <span class="score" [title]="scoreTitle(found)">{{ score(found) }}</span>
                @if (found.verdict === 'skip') {
                  <!--
                    THE VERIFIER'S REJECTION, NAMED. docs/ANALYSIS.md §8: the
                    loosest tier shows the skips *"ghosted and labelled as the
                    verifier's rejection (reported speech, quotation, argument
                    against)"* rather than hiding them — a person hunting for
                    almost everything is owed the net's whole contents, told
                    honestly which fish were thrown back.
                  -->
                  <span
                    class="verdict"
                    title="The verifier read this as reported speech, quotation, or an argument against the claim — not the author asserting it"
                  >not asserted</span>
                }
                @if (found.also.length > 0) {
                  <span class="also" [title]="alsoTitle(found)">+{{ found.also.length }}</span>
                }
              </div>
            </div>
          }
        </div>
      } @empty {
        <p class="none">{{ empty() }}</p>
      }

      <!--
        THE FOOT: what this book could not place, and which categories were never
        calibrated. Sentences rather than a refusal (\`BookLoad.unplaced\`'s own
        precedent) and at the END rather than the top, because they are caveats
        about a list somebody is reading and not reasons not to read it.
      -->
      @if (analysis.unplaced().length > 0) {
        <div class="foot">
          <p class="foot-lede">
            {{ analysis.unplaced().length }} passage(s) could not be placed on this book:
          </p>
          <ul>
            @for (said of analysis.unplaced(); track $index) {
              <li>{{ said }}</li>
            }
          </ul>
        </div>
      }
      @if (untuned(); as names) {
        <div class="foot">
          <p class="foot-lede">
            Nothing has calibrated {{ names }}, so the counts for those are a first draft — they
            may turn up too much or too little.
          </p>
        </div>
      }
    </div>

    <!-- The fuller quotation as a GLANCE: fixed to the viewport at the hovered
         row's edge, pointer-events none, so it occupies no row and moves
         nothing. -->
    @if (wide(); as fuller) {
      @if (glanceBox(); as box) {
        <p
          class="glance"
          [class.above]="box.up"
          [style.top.px]="box.top"
          [style.left.px]="box.left"
          [style.width.px]="box.width"
        >
          <span class="q-before">{{ fuller.before }}</span><span
            class="q-hit"
          >{{ fuller.hit }}</span><span class="q-after">{{ fuller.after }}</span>
        </p>
      }
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      background: var(--bg-sunken);

      /*
        THE ONE INK THIS PANEL LIGHTS WITH, taken from the shell's ROLES and never
        from the paper's hexes.

        The sweep's card makes this argument at length and it transfers word for
        word: the workbench's marks (\`--ink-strike\`, \`--ink-flag\`) are declared
        on the BOOK VIEWER's own host, mixed for a cream sheet, and copying one
        into a charcoal panel puts a paper red on a dark ground at about two to
        one. What carries across a surface change is the role, and a finding's
        role is EMPHASIS rather than refusal or warning — nothing here is an error
        and nothing is being proposed for deletion — so it is the accent.
      */
      --hit-ink: var(--accent);
    }

    /*
      A QUIET BAR, NOT A TAB STRIP — the compare column's head, to the pixel,
      because the two occupy one slot and a person switching between them should
      not feel the furniture change.
    */
    .head {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px 6px 10px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }
    .tag {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--accent);
    }
    .counts {
      flex: 1; min-width: 0;
      font-size: 11.5px; color: var(--text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* ALWAYS VISIBLE, on the compare column's own rule: this is the only way out
       of a mode, and a way out that has to be discovered by hovering is a mode
       people feel stuck in. */
    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* ── The three buttons ──────────────────────────────────────────────────── */
    .tiers {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .tier {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 5px 4px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-secondary);
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .tier:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .tier.on {
      background: var(--accent-faint);
      border-color: var(--accent-strong);
      color: var(--accent);
    }
    .tier-name { font-size: 11px; line-height: 1.2; }
    .tier-count { font-size: 10px; font-variant-numeric: tabular-nums; opacity: 0.75; }

    .problem {
      margin: 0; padding: 8px 10px;
      font-size: 11.5px; line-height: 1.5; color: var(--warn);
      border-bottom: 1px solid var(--border-subtle);
    }

    /* ── The findings ───────────────────────────────────────────────────────── */
    .list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 14px; }
    .none {
      margin: 0; padding: 28px 16px;
      text-align: center;
      font-size: 12px; color: var(--text-tertiary);
    }

    .group-head {
      position: sticky; top: 0;
      z-index: 1;
      display: flex; align-items: baseline; gap: 6px;
      padding: 6px 10px 4px;
      background: var(--bg-sunken);
      border-bottom: 1px solid var(--border-subtle);
    }
    .group-name {
      flex: 1; min-width: 0;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--hit-ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .group-count {
      font-size: 10px; color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    /*
      THE GRID, AND THE THREE NUMBERS THE GLANCE IS POSITIONED FROM. 10px of
      padding, a 92px chip column, an 8px gap on the left; a 54px marks column, an
      8px gap and 10px of padding on the right. \`hover()\` spells the same
      arithmetic and names these — the sweep's own warning is that a copied magic
      number is a glance standing over the wrong column the day a grid moves.
    */
    .row {
      display: grid;
      grid-template-columns: 92px 1fr 54px;
      align-items: start;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row:hover { background: var(--bg-hover); }
    /* A struck block's findings are listed and are inert: seeing that a passage
       the analysis found is one you already cancelled is half of trusting it. */
    .row.ghost { opacity: 0.45; }
    /* And a verdict the verifier REJECTED is shown-but-inert in the same way —
       the treatment a struck row gets, for the reason docs/ANALYSIS.md §8 gives:
       it is the net's contents, honestly labelled, not a finding. */
    .row.rejected .q-hit {
      background: var(--bg-active);
      color: var(--text-secondary);
    }

    .at {
      display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      background: transparent; border: none; cursor: pointer;
      padding: 1px 3px; border-radius: var(--radius-sm);
      text-align: left;
    }
    .at:hover { background: var(--bg-active); }
    .at-id {
      font-family: var(--font-mono); font-size: 10px;
      color: var(--text-secondary);
      max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .at-page { font-size: 9px; color: var(--text-tertiary); }

    .quote {
      margin: 0;
      font-size: 12px; line-height: 1.55;
      color: var(--text-secondary);
    }
    .q-before, .q-after { color: var(--text-tertiary); }
    /*
      THE PASSAGE ITSELF, LIT — one ink, at the alpha the category chips use, and
      never one colour per category. docs/ANALYSIS.md §8: *"the page must not turn
      into confetti"*, and a panel that disagreed with the paper about how many
      inks there are would be two designs about one report.
    */
    .q-hit {
      border-radius: 2px;
      padding: 0 1px;
      background: color-mix(in srgb, var(--hit-ink) 22%, transparent);
      color: var(--text-primary);
    }

    .marks {
      justify-self: end;
      display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
    }
    .score {
      font-family: var(--font-mono); font-size: 10px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .verdict {
      font-size: 8.5px; letter-spacing: 0.04em;
      color: var(--warn);
      white-space: nowrap;
    }
    .also {
      font-size: 9px;
      color: var(--text-tertiary);
    }

    /* ── The caveats, at the foot ───────────────────────────────────────────── */
    .foot {
      padding: 10px 12px 0;
      font-size: 11px; line-height: 1.5;
      color: var(--text-tertiary);
    }
    .foot-lede { margin: 0 0 4px; }
    .foot ul { margin: 0; padding-left: 1.1rem; }
    .foot li { margin: 0 0 2px; }

    /*
      THE GLANCE TAKES NO ROOM IN THE LIST — the sweep's ruling, kept: the fuller
      quotation floats fixed to the viewport at the hovered row's edge,
      pointer-events none so the pointer reads the rows straight through it. 1250
      sits over this column and under the confirmation's 1300, the same ordering
      every card in this app declares.
    */
    .glance {
      position: fixed;
      z-index: 1250;
      pointer-events: none;
      margin: 0;
      padding: 8px 10px;
      font-size: 12px; line-height: 1.55;
      color: var(--text-secondary);
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    }
    .glance.above { transform: translateY(-100%); }
  `],
})
export class AnalysisPanelComponent {
  protected readonly stage = inject(StageService);
  protected readonly analysis = inject(AnalysisViewService);
  private readonly stacks = inject(BookStacksService);

  /** The three buttons, with the sentence each one is owed on hover. */
  protected readonly tiers: readonly { tier: AnalysisTier; name: string; why: string }[] = [
    {
      tier: 'strict',
      name: 'Strict',
      why: 'Only what the verifier flagged, at the near-certain end — the few options.',
    },
    {
      tier: 'moderate',
      name: 'Moderate',
      why: 'What the verifier flagged, at the calibrated default — the ordinary answer.',
    },
    {
      tier: 'loose',
      name: 'Loose',
      why: 'Everything the net caught, including the passages the verifier threw back — '
        + 'shown greyed and labelled.',
    },
  ];

  protected readonly named = analysisCategoryName;

  /** Which row the pointer is over, by key, or null. See the class docblock. */
  protected readonly hovered = signal<string | null>(null);

  /** Where the glance stands, measured off the row at the moment it was entered. */
  protected readonly glanceBox = signal<{ top: number; left: number; width: number; up: boolean } | null>(null);

  /** The findings this tier lets through, grouped by category, in reading order. */
  protected readonly groups = computed(() => byCategory(this.analysis.hits()));

  /** The book on the paper, for the widening — the same rows the placement used. */
  private readonly rows = computed<readonly ReplayedRow[]>(() => {
    const stack = this.stacks.bookStackFor(this.stage.active());
    return stack?.view()?.rows ?? NO_ROWS;
  });

  /**
   * The widened quotation for the hovered row, or null.
   *
   * COMPUTED ON DEMAND, `sweep.widen`'s rule: a second quotation four times the
   * length of the first, held for every finding and drawn for one, is memory kept
   * so a pointer can rest somewhere.
   */
  protected readonly wide = computed(() => {
    const key = this.hovered();
    if (key === null) return null;
    const found = this.analysis.hits().find((one) => one.key === key);
    return found === undefined ? null : widen(this.rows(), found);
  });

  /** The header's line: how many of how many, in words rather than a fraction. */
  protected readonly said = computed(() => {
    if (this.analysis.loading()) return 'Reading the report…';
    const shown = this.analysis.hits().length;
    const all = this.analysis.found().length;
    if (all === 0) return 'Nothing found';
    return shown === all
      ? `${all} ${all === 1 ? 'passage' : 'passages'}`
      : `${shown} of ${all} passages`;
  });

  /** The staleness caveat main composed, or null. See `AnalysisReading.stale`. */
  protected readonly stale = computed(() => this.analysis.reading()?.stale ?? null);

  /**
   * The untuned categories, said aloud — or null where every one was calibrated.
   *
   * NAMED AND NOT COUNTED, which is the report header's own rule (docs/ANALYSIS.md
   * §5): a reader deciding whether to trust a count needs to know WHICH ones are
   * first drafts. Only the ones this report actually ran against appear, because
   * the header lists what the plan held.
   */
  protected readonly untuned = computed<string | null>(() => {
    const said = (this.analysis.reading()?.untuned ?? []).map(analysisCategoryName);
    if (said.length === 0) return null;
    if (said.length === 1) return said[0]!;
    return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]!}`;
  });

  /** What an empty list says, which depends on why it is empty. */
  protected readonly empty = computed(() => {
    if (this.analysis.loading()) return 'Reading the report…';
    if (this.analysis.reading() === null) return '';
    if (this.analysis.found().length === 0) {
      return 'This analysis found nothing in the book at this position.';
    }
    return this.analysis.tier() === 'strict'
      ? 'Nothing is certain enough for Strict. Try Moderate.'
      : 'Nothing at this strictness. Try Loose to see everything the net caught.';
  });

  /** How many findings a tier would show — the number under each button. */
  protected countFor(tier: AnalysisTier): number {
    const all = this.analysis.found();
    if (tier === 'loose') return all.length;
    const floor = tier === 'strict' ? 0.9 : 0.7;
    return all.filter((one) => one.verdict === 'flag' && one.score >= floor).length;
  }

  /**
   * The score, as two decimal places.
   *
   * IT IS SHOWN AT ALL because the tiers slice on it and a person deciding whether
   * to widen from Strict to Moderate is deciding about this number. It is NOT a
   * severity and the tooltip says so: docs/ANALYSIS.md §1 rules that there is no
   * severity and no generated rationale — the passage IS the finding, and this is
   * the ranker's own confidence that the sentence entails the category's claim.
   */
  protected score(hit: AnalysisHit): string {
    return hit.score.toFixed(2);
  }

  protected scoreTitle(hit: AnalysisHit): string {
    return `The entailment score for ${analysisCategoryName(hit.category)} — how strongly the `
      + 'passage matches that category\'s claim. Not a severity: the passage is the finding.';
  }

  protected alsoTitle(hit: AnalysisHit): string {
    return `Also flagged: ${hit.also.map(analysisCategoryName).join(', ')}`;
  }

  /**
   * The pointer, over one row — read off the DOM rather than bound per row.
   *
   * `closest` walks up from whatever the pointer actually entered (the quotation,
   * the chip, a mark) to the row that carries the key. A pointer over the padding
   * between rows finds nothing and the widening closes, which is the honest answer
   * to "which row is this".
   *
   * THE GLANCE IS MEASURED HERE, off the row the pointer just proved, rather than
   * watched reactively: a rect is a fact about the DOM at a moment, and this is
   * the one moment it is known fresh. The offsets are THIS panel's grid — 10px
   * padding + 92px chip column + 8px gap on the left, 54px marks + 8px gap + 10px
   * padding on the right — recomputed rather than copied from the sweep's card,
   * whose columns are different numbers.
   */
  protected hover(event: Event): void {
    const under = event.target instanceof HTMLElement ? event.target.closest('[data-key]') : null;
    if (!(under instanceof HTMLElement)) {
      this.hovered.set(null);
      return;
    }
    this.hovered.set(under.dataset['key'] ?? null);
    const rect = under.getBoundingClientRect();
    const up = rect.bottom > window.innerHeight - 170;
    this.glanceBox.set({
      top: up ? rect.top - 4 : rect.bottom + 4,
      left: rect.left + 110,
      width: Math.max(120, rect.width - 110 - 72),
      up,
    });
  }

  /**
   * A ROW TRAVELS, AND NOTHING CLOSES.
   *
   * The sweep's card closes on the way because it is a modal standing over the
   * page; this is a column standing beside it, which is exactly why Owen asked for
   * the hits to live *"where compare would normally be"*. Click a chip, the block
   * comes to the middle of the page and pulses, and the list is still there to
   * click the next one.
   *
   * THE FIRST SPAN, for a finding that crosses a paragraph break: a passage has
   * one place to be shown from and it is where it begins.
   */
  protected travel(hit: AnalysisHit): void {
    const span = hit.spans[0];
    if (span === undefined) return;
    this.stacks.bookStackFor(this.stage.active())?.reveal(span.id);
  }
}

const NO_ROWS: readonly ReplayedRow[] = [];
