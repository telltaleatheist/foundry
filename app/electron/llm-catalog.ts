/**
 * llm-catalog — the model lineup, and which of it this machine can run.
 *
 * ── WHY THERE IS A TABLE AT ALL ──────────────────────────────────────────────
 *
 * `qwen3.8:27b` is the standing default for every language task (Owen,
 * 2026-08-22: *"27b is the standard we'll use for every task"*), and it will not
 * run on an ordinary computer. Seventeen gigabytes of weights need a card most
 * people do not have; the concrete machine this was written for has eight. A
 * default nobody's hardware can honour is not a high standard, it is an app
 * that appears broken on the first translation somebody tries.
 *
 * So setup measures the machine and offers the LARGEST MODEL THAT ACTUALLY
 * FITS. The lineup is the shipping-model line — not the coding variants, not
 * the BF16 conversions kept for a different runtime — because every row here is
 * something a person is going to run through ollama for prose.
 *
 * ── THE TABLE IS NO LONGER A CONST IN THIS FILE ──────────────────────────────
 *
 * It is `app/shared/model-lineup.json`, vendored, and this file READS it
 * (Wave 61 package D, docs/SLOTS.md §4). **Crucible's manifests are the catalog
 * of record**: each carries a `[local]` block naming the model's local form — an
 * Ollama tag, or a GGUF plus its mmproj — with a memory figure and the BASIS of
 * that figure, and a generator (`crucible/scripts/gen-foundry-lineup.py`) emits
 * `foundry-lineup.json` for Foundry to vendor. A keeper compares by content.
 *
 * Until that generator exists the JSON is written by hand from what this file
 * used to hold, which is why its `generatedBy` says so in as many words rather
 * than claiming a provenance it does not have. Every `needsGB.basis` in it is
 * `"declared"` — the download plus the overhead argued below, arithmetic rather
 * than a measurement — and the day Crucible measures a model's real resident
 * footprint that row's basis becomes `"measured"` and this file does not change.
 *
 * ── THE HEADROOM IS DELIBERATELY GENEROUS, AND ERRS SMALL ────────────────────
 *
 * A declared `needsGB` is the download plus `OVERHEAD_GB`. The overhead is not a
 * fudge: a loaded model also holds a KV cache sized by the context, the runner's
 * own buffers, and whatever the desktop compositor has already taken off the
 * card. 1.5 GB is roughly what that costs at an ordinary context on an ordinary
 * machine, and being wrong in this direction costs somebody a smaller model than
 * they could have had — which they can change in one field — while being wrong
 * in the other direction costs them an hour of a translation running at a word a
 * second, or an out-of-memory failure after a seventeen-gigabyte download. Those
 * two mistakes are not the same size and the number reflects it.
 *
 * THE CONSTANT IS STILL HERE, and it is no longer what the rows are built from:
 * it is what the hand-written JSON was built WITH, and what a future row with no
 * figure at all would fall back to. The file's numbers win.
 *
 * A CONSEQUENCE, STATED SO IT IS NOT MISTAKEN FOR A BUG: an 8 GB card is
 * offered `qwen3.5:4b`, not `qwen3.5:9b`. 6.6 + 1.5 is 8.1, and 8.1 does not
 * fit in 8.0. The row is still there, still installable, and still says why it
 * is marked as not fitting.
 *
 * ── AND ONE PLACE THE RULE INVERTS: A MACHINE WITH NO GPU ───────────────────
 *
 * "Largest that fits" is the right rule only while memory is what binds. With
 * no GPU it is not — see the argument at the branch in `lineupFor` — so a
 * processor-only machine is recommended the SMALLEST model, not the largest its
 * RAM could hold.
 *
 * ── ONE ROW THE OLD CONST DID NOT HAVE, AND IT IS THE APP'S OWN DEFAULT ──────
 *
 * `qwen3.8:27b` is `DEFAULT_TRANSLATE_MODEL` (shared/pipeline.ts) and the Clean
 * text picker's largest option, and it was NOT in `QWEN_LINEUP` — so the wizard
 * could recommend, describe and pull every model except the one every dialog
 * opens with. That is a hole rather than a decision, and the vendored file
 * closes it: the row is there, with the Crucible id BookForge already uses
 * (`qwen3.8-27b-4bit`), placed after `qwen3.5:27b` so that a card which holds
 * exactly one 27B is offered the one the rest of the app defaults to.
 */
import type { LlmModelOption, ModelClass, SystemProfile } from '../shared/types';

/*
 * THE VENDORED TABLE. `resolveJsonModule` is on in tsconfig.electron.json, and
 * `rootDir` is `app/`, so tsc copies this file to `dist/shared/model-lineup.json`
 * beside the emitted JavaScript and electron-builder's `dist/shared/**` picks it
 * up. The RENDERER never imports it — its tsconfig has no `resolveJsonModule`,
 * and it has no business holding a catalog: everything it needs off this table
 * arrives already decided, over IPC.
 */
import lineupFile from '../shared/model-lineup.json';

/** Weights plus working room, for a `declared` figure. See the header. */
export const OVERHEAD_GB = 1.5;

/** Where a `needsGB` came from: somebody measured it, or somebody computed it. */
export interface ModelNeeds {
  value: number;
  basis: 'measured' | 'declared';
}

/** The model as ollama holds it: one tag, pulled through ollama's own library. */
export interface OllamaForm {
  kind: 'ollama';
  tag: string;
  downloadGB: number;
  needsGB: ModelNeeds;
}

/**
 * The model as llama.cpp holds it: a GGUF, and — for a vision model — the
 * separate projector `--mmproj` takes. Two files, because that is how llama.cpp
 * serves a vision tower; see page-reader.ts, which downloads exactly this pair.
 */
export interface GgufForm {
  kind: 'gguf';
  hf_repo: string;
  revision: string;
  file: string;
  mmproj: string;
  downloadGB: number;
  needsGB: ModelNeeds;
}

export type LocalForm = OllamaForm | GgufForm;

/** One row of the vendored catalog. */
export interface LineupRow {
  /** Crucible's model id. The record everything else is keyed by. */
  id: string;
  /**
   * False for a row Crucible has no manifest for — a model that exists only as
   * an Ollama tag on this machine. Kept honest rather than omitted: the app can
   * still fit, pull and run it, and a Crucible server cannot be asked for it.
   */
  crucible: boolean;
  classes: readonly ModelClass[];
  label: string;
  description: string;
  local: LocalForm;
  /**
   * The FLOOR this row sets for those classes — Owen: *"if their system just
   * isnt powerful enough for translation (smaller than 9b) then translation and
   * simplify is disabled."* Read by `eligibleFor`, argued there.
   */
  minimum_for?: readonly ModelClass[];
}

/**
 * ★ THE LINEUP ★ — smallest first, because that is the order the screen reads
 * in, because `lineupFor` walks it forward looking for the last one that fits,
 * and because the `minimum_for` floor is a POSITION in this order.
 *
 * ONE CAST, AND IT IS NOT A SHRUG. `resolveJsonModule` widens every string in a
 * JSON file to `string`, so `"ollama"` does not arrive as the literal `'ollama'`
 * and no amount of annotation makes the assignment check itself. The alternative
 * is a validator that runs at module load and throws — which would mean the app
 * refusing to start because a file that ships INSIDE it is malformed, a state
 * that cannot survive one run of the build. So the shape is asserted here and
 * proved by the keeper that compares this file against Crucible's generator
 * output, which is where a shape disagreement actually originates.
 */
export const MODEL_LINEUP: readonly LineupRow[] =
  lineupFile.models as unknown as readonly LineupRow[];

/** What the file says this file was written from, for the settings row to print. */
export const LINEUP_PROVENANCE: { generatedBy: string; generatedAt: string } = {
  generatedBy: lineupFile.generatedBy,
  generatedAt: lineupFile.generatedAt,
};

/** The rows a person pulls through ollama for prose — the wizard's whole list. */
function textRows(): readonly LineupRow[] {
  return MODEL_LINEUP.filter(
    (row) => row.local.kind === 'ollama' && row.classes.includes('translate'),
  );
}

/**
 * Does ollama already hold this row?
 *
 * THE EXACT TAG, AND ONLY THE EXACT TAG. The docblock here used to claim a bare
 * name matched too — that somebody who ran `ollama pull qwen3.5` and holds
 * `qwen3.5:latest` should not be offered a download of weights they already
 * have — and the code never did it, for a reason worth writing down rather than
 * a second time deleting: `qwen3.5:latest` is ONE size, the library's default,
 * and nothing in this table says which. Matching it by bare name would mark
 * every row in the family installed, so the person with one model would be told
 * they have seven and offered no download at all. Being wrong about which one
 * they have is worse than offering a pull that ollama will answer instantly
 * from its own store.
 */
export function heldBy(row: LineupRow, held: ReadonlySet<string>): boolean {
  if (row.local.kind !== 'ollama') return false;
  return held.has(row.local.tag.toLowerCase());
}

/** The held names as a set, lowercased and trimmed, once per call rather than per row. */
export function heldSet(held: readonly string[]): Set<string> {
  return new Set(held.map((name) => name.trim().toLowerCase()));
}

/** Does this row's memory figure clear what a model can expect to have here? */
export function fitsOn(row: LineupRow, profile: SystemProfile): boolean {
  return row.local.needsGB.value <= profile.modelMemoryMB / 1024;
}

/**
 * The rows that may serve a class on this machine, in lineup order.
 *
 * ── `minimum_for` IS A FLOOR, NOT A NAME ────────────────────────────────────
 *
 * Owen's rule is about SIZE — *"if their system just isnt powerful enough for
 * translation (smaller than 9b)"* — so the row carrying `minimum_for` marks a
 * position in the lineup and everything from there upward qualifies. Reading it
 * as "only this row lights translate" would leave a 24 GB card holding the 27B
 * and nothing else with a dark Translate tile, which is the opposite of the
 * rule's purpose. A class with no floor anywhere (analysis, clean) takes the
 * whole list, which is also Owen's: analysis is a sentence at a time and a small
 * model does it, a translation is a book.
 */
export function eligibleFor(cls: ModelClass): readonly LineupRow[] {
  const serving = MODEL_LINEUP.filter((row) => row.classes.includes(cls));
  const floor = serving.findIndex((row) => row.minimum_for?.includes(cls) === true);
  return floor < 0 ? serving : serving.slice(floor);
}

/**
 * The lineup as this machine sees it: what fits, what is already pulled, and
 * the one row that carries the badge.
 *
 * EXACTLY ONE `recommended`, AND ONLY IF SOMETHING FITS. On a machine where
 * nothing does — no GPU and eight gigabytes of RAM, say — no row is badged, and
 * the caller's `suggested` falls to the smallest with the sentence about the
 * processor. Badging a row that does not fit would be recommending a model this
 * file has just said will not run.
 */
export function lineupFor(profile: SystemProfile, held: readonly string[]): LlmModelOption[] {
  const rows = textRows();
  const holdings = heldSet(held);

  const fitting = rows.filter((row) => fitsOn(row, profile));

  /*
   * ── WITH NO GPU, "FITS" AND "IS USABLE" COME APART ────────────────────────
   *
   * Everywhere else the recommendation is the largest thing that fits, because
   * memory is the binding constraint and a model that fits a card runs at that
   * card's speed. On a machine with no GPU at all, memory stops being the
   * binding constraint: sixteen gigabytes of system RAM will hold `qwen3.5:9b`
   * perfectly well and then generate at a word or two a second, which for a
   * three-hundred-page translation is not slow, it is not going to finish. The
   * largest that fits would be a recommendation nobody could use.
   *
   * So the CPU machine is recommended the SMALLEST, and the whole lineup is
   * still listed with its real fits/doesn't-fit against RAM, so somebody who
   * knows what they are doing and is willing to leave it running overnight can
   * pick a bigger one on purpose. The screen says the machine has no GPU in the
   * line above (`SystemProfile.detail`), which is the sentence that explains
   * why this row and not a larger one.
   *
   * THE TILES GO FURTHER AND REFUSE OUTRIGHT on that machine (act-gates.ts,
   * Owen: *"if a job is going to take an obscenely long time, like translation
   * on cpu, it should just be disabled"*). This function still lists everything,
   * because the wizard's job is to describe the machine and a list with nothing
   * in it describes nothing.
   */
  const best = profile.memoryBasis === 'ram'
    ? fitting[0] ?? null
    : fitting[fitting.length - 1] ?? null;

  return rows.map((row) => ({
    tag: row.local.kind === 'ollama' ? row.local.tag : row.id,
    label: row.label,
    downloadGB: row.local.downloadGB,
    needsGB: row.local.needsGB.value,
    description: row.description,
    fits: fitsOn(row, profile),
    recommended: best !== null && row.id === best.id,
    installed: heldBy(row, holdings),
  }));
}

/**
 * The tag the wizard preselects.
 *
 * The recommendation when there is one; the smallest model otherwise. The
 * second branch is not a fallback that hides a problem — the screen says in as
 * many words that nothing here fits and that this one will run on the
 * processor — it is the answer to "which of these is least bad on this
 * machine", which is a question with an answer even when none of them is good.
 */
export function suggestedTag(options: readonly LlmModelOption[]): string {
  const recommended = options.find((option) => option.recommended);
  if (recommended) return recommended.tag;
  const smallest = options[0]?.tag;
  if (smallest !== undefined) return smallest;
  const first = textRows()[0];
  return first !== undefined && first.local.kind === 'ollama' ? first.local.tag : '';
}
