/**
 * The render pipeline — what Generate MEANS, standing anywhere in the history.
 *
 * ── The approximation this file replaces ────────────────────────────────────
 *
 * Until now the position affected a Generate through exactly one thing: which
 * `--overlay` the engine was handed (`planConversion` → `overlayForPosition`).
 * Standing on a translation, `curationInEffect` walked past it to the nearest
 * curated ancestor and rendered THE BOOK IT WAS TRANSLATED FROM — the state the
 * translation was taken of, which `shared/ledger.ts` called "the honest
 * approximation" and which is a German book for somebody who clicked the row
 * labelled *Translated (Hungarian)*.
 *
 * The fix is not a second rendering path. A translation bank is keyed by
 * `sha256(model, to, from, instructions, masked source text)` and carries no
 * page and no order (`src/translate/bank.ts`), so nothing can ever render FROM
 * one: there is no position in it for an overlay to apply to. What the user's
 * walkthrough needs is a PIPELINE — render the curated book out of the readings
 * bank (free, `--reuse-readings`), then translate that rendering through the
 * translation bank (cache hits, near-free) — and THE POSITION'S ANCESTRY IS THE
 * PIPELINE DESCRIPTION. That is what this module reads off it.
 *
 * ── Why it is pure, and why it is here rather than in `workspace.ts` ────────
 *
 * `shared/ledger.ts`'s reason, one layer up: this decides how many engine runs a
 * button press becomes and which file each of them writes, and a decision like
 * that belongs somewhere a test can reach without an Electron main process. It
 * is also asked from BOTH sides — main composes the plan with it, and the
 * Generate dialog asks (through `translationInEffect`) whether this position is
 * one where only an EPUB can be offered — and a rule spelled on both sides of an
 * IPC boundary is a rule that drifts.
 *
 * ── The table, which is the contract (docs/TRANSLATION-STEPS.md §3) ─────────
 *
 *   standing on            pipeline
 *   ─────────────────────  ────────────────────────────────────────────────
 *   import                 vlm-convert — unchanged
 *   read                   vlm-convert + the live overlay — unchanged
 *   curate (no translate)  vlm-convert + that snapshot — unchanged
 *   translate              vlm-convert (ancestor curation) → TRANSLATE
 *   curate under translate vlm-convert (THIS snapshot) → TRANSLATE
 *
 * The first three rows are `curationInEffect` exactly as it already answers, and
 * that is deliberate rather than lucky: the walk stops at a `read`, so a position
 * with no translation above it cannot reach this file's new behaviour at all. The
 * two new rows are the same walk asked one more question.
 */

import {
  StepLedgerError,
  ancestry,
  curationInEffect,
  positionOf,
  readingInEffect,
  translationInEffect,
} from './ledger';
import type { LedgerStep, ProjectLedger, ThenTranslate, TranslateRequest } from './types';

/**
 * The model a translation is asked of when nobody chose one — the engine's own
 * default (`DEFAULT_TRANSLATE_MODEL`, src/translate/run.ts).
 *
 * ── Why it moved out of the Translate dialog ────────────────────────────────
 *
 * It was a constant in `translate-dialog.component.ts`, where it was the value
 * the field opens on, and that was the whole population of askers. It is not any
 * more: a Generate standing on a translation runs the translate stage with NO
 * DIALOG IN FRONT OF IT — the row is the picker, there is no form to open on
 * anything — so the plan needs the same answer the dialog would have given. Two
 * copies of a model id is two answers the day somebody bumps one of them, and
 * the way that failure presents is a re-render quietly asking a different model
 * than the translation was made with, filling the same bank with answers in a
 * second voice.
 */
export const DEFAULT_TRANSLATE_MODEL = 'qwen3:32b';

/** Ollama's own default port, and where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * What a Generate at the position is made of: one vlm stage, and sometimes a
 * translate stage after it.
 *
 * Every field is a STEP rather than a path, because this module knows nothing
 * about project directories (`shared/ledger.ts`'s rule, and the reason both of
 * them are testable). Main turns the steps into the three paths the engine is
 * handed.
 */
export interface RenderPipeline {
  /**
   * The curation snapshot the vlm stage renders with, or null when the answer is
   * the live overlay.
   *
   * `curationInEffect`, unchanged and un-second-guessed. Standing on a `curate`
   * gives that snapshot — including one made UNDER a translation, which is the
   * whole of the user's strike-then-re-render walkthrough; standing on a
   * `translate` walks past it to the curation the translation was made under,
   * which is the state its blocks were numbered in.
   */
  curation: LedgerStep | null;
  /**
   * The reading whose bank the vlm stage replays, or null for a project with no
   * reading on the path (a position standing on the import, most of all).
   */
  reading: LedgerStep | null;
  /**
   * The translation the second stage produces again, or null for a Generate that
   * is one run of `vlm-convert` and nothing else.
   *
   * It supplies `--to` (`params.language`) and `--bank` (`params.bank`, with
   * `translationBankOf`'s legacy fallback applied by the caller that knows the
   * project key). NOT its payload: where this run WRITES is decided by
   * `translationTarget` against `landsUnder` below, which is the same question
   * asked the same way for a translation ordered from the Translate dialog.
   */
  translate: LedgerStep | null;
  /**
   * The step the translated EPUB is filed against — and it is NOT always the
   * position, which is the one surprising line in this file.
   *
   * ── Why re-rendering a translation is filed under its PARENT ────────────────
   *
   * A translation lands a ledger step (`recordGenerated`), and which step is
   * decided by `reRunTarget`: same action, same parent, same language is the row
   * that already exists, and it REPLACES. Standing on the Hungarian translation
   * and pressing Generate is the user asking for that row again — so the landing
   * has to ask the question the row itself would answer, which means filing it
   * against the row's own parent. Filing it against the POSITION instead would
   * make it a translation whose parent is a translation: a second row, beside the
   * one the user was standing on, for a run they asked for to refresh it.
   *
   * ── And why a curate under a translation is filed against ITSELF ────────────
   *
   * Because it is a different book. The pipeline applies THAT snapshot's strikes
   * before the translate stage sees a word, so its EPUB is not the file the
   * translate step's payload holds — and quietly writing it there would make the
   * translation's own row describe a book with ten paragraphs missing that
   * nothing in the ledger admits to removing. It is a different parent, so it is
   * a different question, so `translationTarget` mints it a branch: its own EPUB
   * and its own bank, exactly as translating from that save through the Translate
   * dialog would have. Doing it twice replaces, because the second run asks the
   * same question from the same parent — which is precisely the behaviour the
   * user's walkthrough describes ("click that entry and Generate re-renders with
   * the stricken items removed", and it does not accumulate rows).
   *
   * Null when `translate` is null: a rendering is not a step and has nothing to
   * be filed against.
   */
  landsUnder: string | null;
}

/**
 * The ancestry, read as a pipeline — or a refusal naming what it will not do.
 *
 * ── The one hop, stated rather than discovered ──────────────────────────────
 *
 * A translation MADE FROM ANOTHER TRANSLATION is refused here, at plan time, with
 * a sentence. The model permits that chain — translate to Hungarian, stand on it,
 * translate that to English, and the ledger records both honestly — and this pass
 * does not pretend to run it. Rendering the English row would mean `vlm-convert →
 * translate → translate`: three spawns, two intermediates, and a bank chain
 * nothing in this app names. Rendering it the way this file otherwise would —
 * scan to English in one hop — is worse than refusing, because that row's bank
 * holds English keyed to HUNGARIAN source text, so every block would miss, the
 * run would silently re-translate the whole book out of the German, and the row
 * would end up holding a book it does not describe. DEFERRED BY DESIGN
 * (docs/TRANSLATION-STEPS.md §3, "One hop"), and named out loud so the person who
 * meets it knows it is a bound rather than a bug: they can stand on the Hungarian
 * row and generate that.
 *
 * ── Why the test is the PARENT and not "a translate anywhere above" ─────────
 *
 * §3 words the bound as "a translate step whose ancestry holds another translate
 * step", and taken literally that refuses the user's own walkthrough on its
 * second press. Strike some blocks while standing on the Hungarian translation,
 * commit — the save hangs UNDER the translation, which is what `recordCuration`
 * has always done — and generate: that lands a translate step whose ancestry is
 * import → read → Hungarian → save → this. Two translate steps on one chain, and
 * the row the walkthrough exists to make would refuse to render itself.
 *
 * It is not a chain, and the reason is what a curation step's payload IS. A
 * curation freezes the LIVE OVERLAY, which is corrections to the SCAN's blocks
 * bound to the reading's generation — §1's discovery, that curation stays keyed
 * to the reading, where the blocks actually live. So a translation made from a
 * curation is a translation of the curated SCAN however far down the list that
 * curation was committed, and rendering it is exactly one vlm run plus one
 * translate run. What genuinely stacks is a translation made from a TRANSLATION,
 * with no curation in between to re-base it on the pages — and since every step's
 * parent is an import, a read, a curate or a translate, "the nearest thing above
 * that could re-base this" is simply the parent.
 *
 * The refusal is a `StepLedgerError` for the reason every refusal in this app is
 * its own class: main hands the message to the dialog verbatim, and a caller has
 * to be able to tell a rule from a filesystem accident.
 */
export function renderPipeline(ledger: ProjectLedger): RenderPipeline {
  const standing = positionOf(ledger);
  const translate = translationInEffect(ledger);
  const base: RenderPipeline = {
    curation: curationInEffect(ledger),
    reading: readingInEffect(ledger),
    translate: null,
    landsUnder: null,
  };
  if (translate === null || standing === null) return base;

  const chain = ancestry(ledger, translate.id);
  const from = chain[chain.length - 2];
  if (from !== undefined && from.action === 'translate') {
    throw new StepLedgerError(
      `“${translate.label}” was made from “${from.label}”, and Foundry renders one translation deep. `
      + `Stand on “${from.label}” and generate that one instead.`,
    );
  }

  return {
    ...base,
    translate,
    // The position's parent when the position IS the translation — see
    // `landsUnder`, which is where the whole of this line's reasoning lives.
    landsUnder: standing.id === translate.id ? standing.parent : standing.id,
  };
}

/**
 * The second stage as the request it is — the same shape a translation ordered
 * from the Translate dialog becomes, so `argsFor` composes ONE command line.
 *
 * ── Why this exists rather than a second arm in `argsFor` ───────────────────
 *
 * The translate command line has seven flags and two conditionals, and every one
 * of them was learned the expensive way (`--bank` is on that list because a
 * 456-block book was killed at block 152 having written nothing). A second place
 * spelling it is a second place to forget one, and the way that failure presents
 * is a pipeline whose translate stage banks nothing and re-asks the model for the
 * whole book on the next run. So the stage becomes a `TranslateRequest` and goes
 * through the one function that has always known how to spell one.
 *
 * `from` is the intermediate the vlm stage just wrote — in the OS temp directory,
 * never in `generated/`, because debris does not go where products live. It is
 * the caller's to compose and the caller's to delete.
 */
export function translationStage(
  then: ThenTranslate,
  from: string,
  outputPath: string,
): TranslateRequest {
  return {
    kind: 'translate',
    inputPath: from,
    outputPath,
    to: then.to,
    model: then.model,
    ollama: then.ollama,
    bankPath: then.bank,
    // Carried so the spawn can copy the parent's answers into a branch's empty
    // bank (`ThenTranslate.seedBank`). Not a flag: `argsFor` never sees it.
    ...(then.seedBank !== undefined ? { seedBank: then.seedBank } : {}),
    ...(then.instructions !== undefined && then.instructions.trim().length > 0
      ? { instructions: then.instructions }
      : {}),
  };
}
