/**
 * catalog — the weights Foundry knows how to fetch.
 *
 * One base model and three stage models (ARCHITECTURE §3). Two of the three are
 * LoRA adapters: the base is a few gigabytes and stays resident, the adapters
 * are tens of megabytes and swap per request, which is the whole reason this is
 * one base with adapters rather than three fine-tunes.
 *
 * `blocks` is the exception, and it is a fact about the weights rather than a
 * design choice: the checkpoint that shipped is a FUSED full model, so it is
 * catalogued as `kind: 'full'` and served on its own with no adapter. Nothing
 * pretends otherwise — a full checkpoint declared as an adapter would be loaded
 * with `--lora-scaled` and produce a server that answers with the base's
 * behaviour, which is the failure mode this file exists to prevent.
 *
 *   Hosting:  huggingface.co/owenmorgan/<repo>, direct resolve URLs
 *   On disk:  see paths.ts — a platform data dir, or `--models-dir`
 *   Verified: sha256 on arrival, see download.ts
 *
 * Two rules carried over from BookForge's `rubric-models.ts`, both learned:
 *
 *  1. **Entries are never deleted once published.** Someone is mid-book with the
 *     weights they already have on disk, and removing the entry turns their
 *     working install into an unknown-model error. A superseded entry stays,
 *     with a lower `rank`.
 *  2. **`rank` picks the default.** Highest rank among the models actually
 *     present on disk wins. That is how a new version becomes the default
 *     without anything having to be uninstalled first.
 *
 * And the one that cost real time over there: **a catalog entry is not a
 * published model.** The entry can be written, committed and shipped while the
 * weights do not yet exist at that URL, and the failure lands on a stranger's
 * first run. Check the HuggingFace repo, never this file, for what is live.
 */

/**
 * What a file IS, which decides how llama-server is told to load it.
 *
 *  - `base`    the resident base every adapter rides. Loaded with `-m`.
 *  - `adapter` a LoRA. Loaded with `-m <base> --lora-scaled <this>`.
 *  - `full`    a fused fine-tune that already contains the tune. Loaded with
 *              `-m <this>` and NO lora flag, and it does not need the base on
 *              disk at all.
 *
 * This is deliberately NOT derivable from the id: `foundry-blocks-v1-4b` says
 * which stage, which release and which base size, and none of that tells you
 * whether the tune was merged. A stage can ship an adapter at v1 and a fused
 * model at v2 without its ids changing shape, so the id grammar checks the
 * stage and the catalog entry declares the packaging.
 */
export type FoundryModelKind = 'base' | 'adapter' | 'full';

/**
 * The three stages that have their own model. Named for what they DO, which
 * is the rename that came with the extraction: rubric → blocks, galley/proof →
 * ocr, dagger → footnotes.
 */
export type FoundryStage = 'blocks' | 'ocr' | 'footnotes';

export interface FoundryModelDef {
  /**
   * Stable id, and the load-bearing string in the system.
   *
   * The version segment selects the prompt format and the legal class list
   * downstream (ARCHITECTURE §3). An id without a version parses as v1 and
   * produces a prompt advertising a retired taxonomy — which does not error, it
   * just quietly scores worse, and reads as an undertrained model. Ids are
   * therefore validated by `parseModelId`, not trusted.
   */
  id: string;
  /** User-facing name. Says what it does, not what it is built from. */
  name: string;
  /** Basename on disk. Unique across the catalog — one file, one entry. */
  filename: string;
  /** Direct resolve URL. */
  url: string;
  /** Lowercase hex. A file that does not match is deleted and named. */
  sha256: string;
  /** Exact size in bytes. The cheap presence check; sha256 is the real one. */
  bytes: number;
  /** Preferred when more than one is installed — higher wins. */
  rank: number;
  kind: FoundryModelKind;
  /**
   * Which stage these weights serve. Set for `adapter` and `full`, absent for
   * the base — the base serves every stage, which is the point of it.
   */
  stage?: FoundryStage;
  /**
   * The prompt format these weights were TRAINED on, when the stage has
   * versioned prompt formats. Today that is `blocks` and only `blocks`, where it
   * selects the system prompt and the legal class list (`blocksCategories`).
   *
   * This is a separate number from the version in the id, and conflating them
   * is the trap. The id's version is the RELEASE line — foundry's stage lines
   * restart at v1 — while the prompt format has its own history that predates
   * the extraction: `foundry-blocks-v1-4b` IS rubric v5, so it is release v1 of
   * a v5 prompt. Reading the format out of the id would hand it the v1 prompt,
   * which advertises a retired sixteen-class taxonomy. That does not error; it
   * just scores worse and reads as an undertrained model.
   *
   * `blocksVersionFor(name)` — the filename rule — stays correct and stays the
   * answer for `--base-model`/`--adapter` overrides, where there is no catalog
   * entry to ask and the filename is all there is.
   */
  promptVersion?: number;
  /** One line for `foundry models list`. */
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Id grammar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base ids: `foundry:4b`. No adapter segment, because the base is not
 * stage-specific.
 */
const BASE_ID = /^foundry:(\d+)b$/;

/**
 * Stage ids: `foundry-blocks-v1-4b`. Stage, release version, and the size of the
 * base it was trained against — an adapter is only valid on the base it was
 * tuned on, and a fused checkpoint is still a 4B model, so the size travels with
 * it either way.
 */
const STAGE_ID = /^foundry-(blocks|ocr|footnotes)-v(\d+)-(\d+)b$/;

export interface ParsedModelId {
  /**
   * `'stage'`, not `'adapter'`: the id names which stage the weights serve, and
   * says nothing about whether the tune is a LoRA or fused. That is the
   * catalog's `kind`, declared per entry.
   */
  kind: 'base' | 'stage';
  /** Undefined for the base. */
  stage?: FoundryStage;
  /** Undefined for the base — the base is versioned by its size and hash. */
  version?: number;
  /** Parameter count in billions, as written in the id. */
  sizeB: number;
}

/**
 * Parse an id, or throw naming the two legal shapes.
 *
 * This is the validation ARCHITECTURE §3 asks for. It exists here, at the
 * catalog, so a malformed id fails when the entry is added rather than deep in
 * a run — but note that the *prompt-format* consequence of the version number
 * belongs to the stage that owns the format (`src/blocks/`), not here. This file
 * checks that a version is present and well-formed; it does not decide what the
 * version means.
 */
export function parseModelId(id: string): ParsedModelId {
  const base = BASE_ID.exec(id);
  if (base) return { kind: 'base', sizeB: Number(base[1]) };

  const stage = STAGE_ID.exec(id);
  if (stage) {
    return {
      kind: 'stage',
      stage: stage[1] as FoundryStage,
      version: Number(stage[2]),
      sizeB: Number(stage[3]),
    };
  }

  throw new Error(
    `Malformed model id: ${id}. Expected a base id like \`foundry:4b\` or a `
    + `stage id like \`foundry-blocks-v1-4b\` (stage, version, base size). The `
    + `version segment is load-bearing — an id without one reads as v1 and gets `
    + `a prompt for a retired taxonomy.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every entry here is LIVE at its url, and that is the standing rule: upload,
 * verify the uploaded bytes, THEN add the entry with the real hash. An invented
 * hash is worse than no entry — it turns "not published yet", which is a clear
 * message, into a checksum mismatch on a stranger's first run, which reads as a
 * corrupt download.
 *
 * And the two rules from the file header: never delete a published entry, and
 * let `rank` pick the default.
 */
const HF = 'https://huggingface.co/owenmorgan/foundry-models/resolve/main';

export const FOUNDRY_MODELS: FoundryModelDef[] = [
  /*
   * PUBLISHED Aug 2 2026, all three verified on the repo after upload
   * (x-linked-size == bytes below; local sha256 recorded at cast time).
   *
   * The base is f16, NOT a quant, deliberately: the owner measured a tangible
   * quality drop on the blocks family at Q8, and in base+adapter serving the
   * base's precision is global to every stage. The adapters were trained bf16
   * against exactly this base snapshot (unsloth/Qwen3-4B @ 6403365), so f16
   * base + f16 adapter is the precision training saw. A quant is a decision to
   * make with per-stage measured deltas, never by habit.
   */
  {
    id: 'foundry:4b',
    name: 'Foundry base model (4B)',
    filename: 'foundry-4b-f16.gguf',
    url: `${HF}/foundry-4b-f16.gguf`,
    sha256: '557b8c7c2ab8b8825562d19664fb5d206e8f9e8e6f3d8d14d351706c48953219',
    bytes: 8051285600,
    rank: 100,
    kind: 'base',
    note: 'The one resident base every adapter rides. f16 — see the block comment.',
  },
  {
    id: 'foundry-ocr-v1-4b',
    name: 'OCR repair (line corrector)',
    filename: 'foundry-ocr-v1-4b.gguf',
    url: `${HF}/foundry-ocr-v1-4b.gguf`,
    sha256: 'f3ee7f6527ecab5998b68fbd2a37cf6507b0938f83460498014850227b478595',
    bytes: 132155232,
    rank: 100,
    kind: 'adapter',
    stage: 'ocr',
    note: 'galley v1.1 epoch 2. Base+adapter scored equal to the merged weights '
      + 'on 2,000 held-out lines (CER 0.353%→0.306%, degraded 56, falseEdits 42).',
  },
  {
    id: 'foundry-footnotes-v1-4b',
    name: 'Footnote-marker removal',
    filename: 'foundry-footnotes-v1-4b.gguf',
    url: `${HF}/foundry-footnotes-v1-4b.gguf`,
    sha256: 'd1a733897479b03419eac5577907fbf4488088f8ad03eea17beade7bbfed2a49',
    bytes: 132155616,
    rank: 100,
    kind: 'adapter',
    stage: 'footnotes',
    note: 'Trained on sft + mined-EPUB + manufactured boundary cases. Base+adapter '
      + 'scored identical to merged: 97.0% applied / 0.5% false-fire on clean text, '
      + '90.5% / 2.1% on raw OCR. Runs after ocr, so clean text is its surface.',
  },
  /*
   * PUBLISHED Aug 3 2026. Verified on the repo after upload: x-linked-size ==
   * bytes below, x-linked-etag == sha256 below.
   *
   * A FULL FUSED MODEL, not an adapter, and the same 8,051,285,248 bytes that
   * every blocks measurement was taken on — byte-identical to
   * bookforge-rubric/rubric-v5-4b-f16.gguf, uploaded rather than re-quantized,
   * because a re-quantize would be a model nobody has scored. It is 8 GB where
   * the other two stages are 132 MB, which is the honest cost of the checkpoint
   * that exists; when blocks is retrained as a LoRA against `foundry:4b` its
   * entry lands here as `kind: 'adapter'` with a higher rank and this one stays.
   */
  {
    id: 'foundry-blocks-v1-4b',
    name: 'Page layout model',
    filename: 'foundry-blocks-v1-4b.gguf',
    url: `${HF}/foundry-blocks-v1-4b.gguf`,
    sha256: '4b991fca888de5cf5926d15d67b4eac979fda16fb9d3078ffdcd9f816b7e9a9a',
    bytes: 8051285248,
    rank: 100,
    kind: 'full',
    stage: 'blocks',
    promptVersion: 5,
    note: 'rubric v5, fused f16 — release v1 of a v5 PROMPT (twelve classes, '
      + 'table merged into list). Labels a whole page exactly right far more often '
      + 'than v4: 79% against 57% on the same split. Loads on its own, no adapter.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the catalog is internally consistent, or throw naming the offender.
 *
 * Run at module load, so a bad entry fails on the very first command rather
 * than at the moment a user tries to download it. This is cheap — the catalog
 * is a handful of entries — and it is the only place that can catch a
 * copy-paste that left the previous version's filename or hash in place.
 */
export function assertCatalogValid(models: readonly FoundryModelDef[] = FOUNDRY_MODELS): void {
  const ids = new Set<string>();
  const filenames = new Set<string>();

  for (const m of models) {
    const parsed = parseModelId(m.id);

    const declaredKind = m.kind === 'base' ? 'base' : 'stage';
    if (parsed.kind !== declaredKind) {
      throw new Error(
        `Catalog: ${m.id} declares kind '${m.kind}' but its id parses as `
        + `'${parsed.kind}'. A base id names no stage; a stage id always does.`,
      );
    }
    if (m.kind === 'base') {
      if (m.stage !== undefined) {
        throw new Error(
          `Catalog: ${m.id} is the base model and must not name a stage `
          + `(got '${m.stage}'). The base serves every stage.`,
        );
      }
    } else if (m.stage !== parsed.stage) {
      throw new Error(
        `Catalog: ${m.id} declares stage '${m.stage ?? 'none'}' but its id `
        + `names '${parsed.stage}'.`,
      );
    }

    // The trap this exists for: the blocks prompt format is NOT the version in
    // the id, and a blocks entry that leaves it out gets `blocksVersionFor` on a
    // `foundry-blocks-vN` id — which reads release v1 as PROMPT v1 and hands the
    // model the retired sixteen-class taxonomy. It does not error. It just
    // scores worse and reads as a bad model.
    if (m.stage === 'blocks' && m.promptVersion === undefined) {
      throw new Error(
        `Catalog: ${m.id} serves the blocks stage and must declare `
        + `promptVersion — the prompt format its weights were trained on, which `
        + `is a different number from the release version in its id.`,
      );
    }
    if (m.promptVersion !== undefined
      && (!Number.isInteger(m.promptVersion) || m.promptVersion <= 0)) {
      throw new Error(
        `Catalog: ${m.id} has a non-positive promptVersion (${m.promptVersion}).`,
      );
    }

    if (ids.has(m.id)) throw new Error(`Catalog: duplicate model id '${m.id}'.`);
    ids.add(m.id);

    // Two entries writing to one filename would have the second silently read
    // as "already installed" once the first was downloaded.
    if (filenames.has(m.filename)) {
      throw new Error(
        `Catalog: duplicate filename '${m.filename}' (on ${m.id}). Every entry `
        + `owns its own file, or one download reads as the other.`,
      );
    }
    filenames.add(m.filename);

    if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
      throw new Error(
        `Catalog: ${m.id} has a sha256 that is not 64 lowercase hex characters. `
        + `An entry without a real hash is worse than no entry — publish first, `
        + `then paste the verified hash.`,
      );
    }
    if (!Number.isInteger(m.bytes) || m.bytes <= 0) {
      throw new Error(`Catalog: ${m.id} has a non-positive byte count (${m.bytes}).`);
    }
    if (!Number.isInteger(m.rank)) {
      throw new Error(`Catalog: ${m.id} has a non-integer rank (${m.rank}).`);
    }
    if (!m.url.startsWith('https://')) {
      throw new Error(`Catalog: ${m.id} has a non-https url (${m.url}).`);
    }
  }
}

assertCatalogValid();

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

export function getModelDef(id: string): FoundryModelDef | undefined {
  return FOUNDRY_MODELS.find((m) => m.id === id);
}

/**
 * Every entry for a role, highest rank first.
 *
 * A stage matches on `stage`, never on `kind`: an adapter and a fused full model
 * are two packagings of the same role, and a stage that switches from one to the
 * other must not lose its old entries from the list — someone mid-book has them
 * on disk.
 */
export function modelsFor(
  role: 'base' | FoundryStage,
  models: readonly FoundryModelDef[] = FOUNDRY_MODELS,
): FoundryModelDef[] {
  const matching = role === 'base'
    ? models.filter((m) => m.kind === 'base')
    : models.filter((m) => m.stage === role);
  return [...matching].sort(byRankDesc);
}

/**
 * The catalogued default for a role: highest rank.
 *
 * Note this says nothing about what is on disk — `paths.isModelPresent` does.
 * `foundry models pull` wants the catalogued default; a run wants the best one
 * actually installed, which is `bestInstalled` in the CLI layer once it has a
 * models dir to look in.
 */
export function defaultModelFor(
  role: 'base' | FoundryStage,
  models: readonly FoundryModelDef[] = FOUNDRY_MODELS,
): FoundryModelDef | undefined {
  return modelsFor(role, models)[0];
}

/**
 * The catalogued default, or an error saying why there isn't one.
 *
 * No fallback (ARCHITECTURE §8): the message says the weights are not published
 * rather than pretending the model is merely missing from disk — those are
 * different problems with different remedies, and conflating them sends people
 * looking in their own filesystem for something that was never uploaded.
 *
 * Every role has a published default today, so this throws only for a role whose
 * entries were removed — which the header forbids.
 */
export function requireDefaultModel(
  role: 'base' | FoundryStage,
  models: readonly FoundryModelDef[] = FOUNDRY_MODELS,
): FoundryModelDef {
  const def = defaultModelFor(role, models);
  if (def) return def;
  throw new Error(
    `No ${role} model is published. The Foundry weights for that role are not `
    + `on HuggingFace — src/models/catalog.ts carries no entry for it. There is `
    + `nothing to download and no substitute to run instead. A local GGUF can be `
    + `pointed at directly with --base-model <file> (and --adapter <file>).`,
  );
}

function byRankDesc(a: FoundryModelDef, b: FoundryModelDef): number {
  if (b.rank !== a.rank) return b.rank - a.rank;
  // Ties are a catalog bug, but sort deterministically so `models list` does
  // not reorder itself between runs.
  return a.id.localeCompare(b.id);
}
