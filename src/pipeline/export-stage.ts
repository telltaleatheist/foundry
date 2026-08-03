/**
 * export-stage — read the run directory, write `export/book.epub` and
 * `export/exclusions.json`.
 *
 * This is the seam PIPELINE.md describes: "re-export is cheap by construction —
 * editing exclusions and re-running `foundry export` touches no upstream stage,
 * no re-scan, no re-inference." Everything this function needs is already on
 * disk, so the pdf-picker interaction (delete boxes → instant reflow) is a
 * re-read of four JSON files and a rebuild of the container.
 *
 * ## Where a block's text comes from
 *
 * A ladder, and it is a PIPELINE ORDER, not a fallback chain: each stage's
 * output supersedes the one before it, and a stage that ran must have covered
 * everything it claims to.
 *
 *   1. `--overrides`, when the caller names the block — the USER's text, taken
 *      as ONE unit. Above every stage, because a person looked at the page.
 *   2. `footnotes/deletions.json`, when it has a record for the block — the
 *      marker-stripped text, already joined, taken as ONE unit.
 *   3. `ocr/lines.json`, when it exists — the corrected line text.
 *   4. `scan/lines.json` — what Tesseract read.
 *
 * The strictness that makes it not a fallback: **if `ocr/lines.json` exists, it
 * must contain every line the blocks reference.** A partially-populated OCR
 * artifact silently mixing corrected and uncorrected lines is exactly the
 * quiet degradation the no-fallbacks rule exists to prevent, so a missing line
 * throws and names it.
 *
 * ## Overrides: the user's edit, carried into the book
 *
 * `--overrides <file>` is `{ blocks: [{ id, text?, category? }] }`, and it is
 * how a decision made in BookForge's pdf-picker reaches the EPUB. A user who
 * retypes a chapter heading — because block formation split it across three
 * blocks, or because the scan read "The Lost Empire t" — is correcting the
 * book, and that correction has to survive the trip through the CLI.
 *
 * It rides at the TOP of the ladder rather than beside the exclusions because
 * it is the same kind of statement the stages make ("this block's text is X"),
 * made by the one participant who can actually see the page. `category` is the
 * matching statement about what the block IS, and it lands before grouping, so
 * a block relabelled `chapter` opens a section exactly as a labelled one would.
 *
 * Every id must exist in `blocks/blocks.json`. An id that does not is a stop
 * naming it — an overrides file written against a different run of the blocks
 * stage is the same failure as a stale `--exclude-ids` list, and applying the
 * half of it that still matches would put a user's chapter title on whatever
 * block inherited the name.
 *
 * ## The cover comes from outside the pipeline
 *
 * `--cover <file>` is the one input to this stage that is not in the run
 * directory. No stage produced it, nothing OCRs it, and no text comes out of
 * it: the bytes are embedded verbatim as the book's cover image. All this
 * function does is read the file; `export/cover.ts` decides whether it is one.
 *
 * ## The one sanctioned degradation
 *
 * A book with no detectable paragraph convention exports successfully with few
 * or no paragraph breaks, and says so at the top of its voice: the verdict goes
 * into the returned report, and this stage writes it to the log. It is never an
 * exception and it is never quiet.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  epubPath, hasArtifact, readBlocks, readFootnoteDeletions, readOcrLines, readRun, readScanLines,
  writeArtifact,
} from './artifacts.js';
import type { Block, CalibrationVerdict, FootnoteBlockDeletions, ScanLine } from './artifacts.js';
import { applyFootnoteDeletions } from '../footnotes/applier.js';
import { attestationFromLines } from '../paragraphs/hyphen.js';
import type { CoverImage } from '../export/cover.js';
import { buildEpub, type BuildEpubResult, type EpubMetadata } from '../export/epub.js';
import type { ExclusionRequest } from '../export/exclude.js';
import { BLOCKS_CATEGORIES_V6, type BlocksCategory } from '../blocks/encoder.js';

export class ExportStageError extends Error {
  constructor(message: string) {
    super(`export: ${message}`);
    this.name = 'ExportStageError';
  }
}

/**
 * One user decision about one block.
 *
 * Both fields are optional individually, but an entry carrying neither is a
 * no-op instruction — almost always a serialization bug on the caller's side —
 * and is refused rather than counted as applied.
 */
export interface BlockOverride {
  /** A block id from `blocks/blocks.json`. Must exist. */
  id: string;
  /** Replaces the block's text ENTIRELY, as one unit. */
  text?: string;
  /** Replaces the block's category. Validated against the legal list. */
  category?: string;
}

export interface OverrideRequest {
  readonly blocks: readonly BlockOverride[];
}

export interface ExportStageOptions {
  runDir: string;
  /** Omitted, it is derived from the run directory — see `deriveMetadata`. */
  metadata?: EpubMetadata;
  exclude?: ExclusionRequest;
  /** The user's own text and category decisions — see the ladder above. */
  overrides?: OverrideRequest;
  /**
   * `--cover`: an image file to embed as the book's cover. External to the
   * pipeline in every sense — it is not in the run directory, no stage produced
   * it, and nothing reads a word out of it.
   */
  coverPath?: string;
  /**
   * An extra destination for the same bytes (`--output`). The canonical
   * `<run>/export/book.epub` is ALWAYS written regardless: the run directory is
   * the contract, and a copy somewhere convenient does not replace it.
   */
  outputPath?: string;
  /** Where the loud verdict goes. Defaults to stderr. */
  log?: (message: string) => void;
}

export interface ExportStageResult extends BuildEpubResult {
  /** The canonical `<run>/export/book.epub`, always written. */
  epubPath: string;
  /** Where `--output` asked for it; equal to `epubPath` when it did not ask. */
  outputPath: string;
  /** True iff the book had no detectable paragraph convention. */
  degraded: boolean;
  /** How many blocks the caller's overrides retyped, and how many they relabelled. */
  overrides: { text: number; category: number };
}

const LEGAL_CATEGORIES = new Set<string>(BLOCKS_CATEGORIES_V6);

/**
 * Apply the caller's overrides to the blocks and their text.
 *
 * Returns fresh blocks and a fresh text map: the artifacts on disk are never
 * touched, so the run directory still describes what the pipeline decided and
 * the override file is the complete record of what the user changed on top.
 *
 * Nothing here is lenient. An unknown id, an unknown category, an entry that
 * says nothing and an empty replacement text are all stops that name the block,
 * because every one of them means the caller believes it changed something that
 * did not change — and the user would find out by reading the finished book.
 */
function applyOverrides(
  blocks: readonly Block[],
  blockText: ReadonlyMap<string, readonly string[]>,
  request: OverrideRequest | undefined,
): { blocks: Block[]; blockText: Map<string, string[]>; counts: { text: number; category: number } } {
  const nextText = new Map<string, string[]>(
    [...blockText].map(([id, units]) => [id, [...units]] as [string, string[]]),
  );
  const counts = { text: 0, category: 0 };
  const entries = request?.blocks ?? [];
  if (entries.length === 0) return { blocks: [...blocks], blockText: nextText, counts };

  const byId = new Map(blocks.map(b => [b.id, b] as const));
  const unknown = entries.filter(o => !byId.has(o.id)).map(o => o.id);
  if (unknown.length > 0) {
    throw new ExportStageError(
      `${unknown.length} override(s) name block id(s) that are not in blocks/blocks.json:`
      + ` ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ', …' : ''}.`
      + ' The overrides were written against a different run of the blocks stage; re-export from'
      + ' the blocks that are actually there rather than editing text nothing will read.',
    );
  }

  const category = new Map<string, BlocksCategory>();
  for (const o of entries) {
    if (o.text === undefined && o.category === undefined) {
      throw new ExportStageError(
        `the override for block ${o.id} sets neither text nor category, so it asks for nothing.`
        + ' Give it a `text`, a `category`, or leave the block out of the file.',
      );
    }
    if (o.category !== undefined) {
      if (!LEGAL_CATEGORIES.has(o.category)) {
        throw new ExportStageError(
          `the override for block ${o.id} asks for category "${o.category}", which is not a`
          + ` category. Legal categories are: ${BLOCKS_CATEGORIES_V6.join(', ')}`,
        );
      }
      category.set(o.id, o.category as BlocksCategory);
      counts.category++;
    }
    if (o.text !== undefined) {
      if (o.text.trim().length === 0) {
        throw new ExportStageError(
          `the override for block ${o.id} replaces its text with nothing. A block with no text is`
          + ' a block that should not ship — drop it with --exclude-ids instead.',
        );
      }
      // ONE unit: the user typed a finished line, so there is no wrap hyphen in
      // it to prove and nothing for the line-join rules to decide.
      nextText.set(o.id, [o.text]);
      counts.text++;
    }
  }

  const next = blocks.map(b => {
    const c = category.get(b.id);
    return c === undefined ? b : { ...b, category: c };
  });
  return { blocks: next, blockText: nextText, counts };
}

/**
 * Assemble every block's text units from the artifacts on disk.
 *
 * Returned as ORDERED UNITS rather than joined strings so the line-join rules
 * still see the wrap hyphens — the evidence is destroyed by joining, and it is
 * the only thing that can prove a split word.
 */
function collectBlockText(runDir: string, blocks: readonly Block[]): {
  blockText: Map<string, string[]>;
  allLines: string[];
  /** Every scan line, carrying its final (ocr-corrected) text. */
  lines: ScanLine[];
} {
  const scan = readScanLines(runDir);
  const text = new Map<string, string>();
  for (const l of scan.lines) text.set(l.id, l.text);

  if (hasArtifact(runDir, 'ocrLines')) {
    const ocr = readOcrLines(runDir);
    const corrected = new Map(ocr.lines.map(l => [l.id, l.text] as const));
    const missing = blocks
      .flatMap(b => b.lineIds)
      .filter(id => !corrected.has(id));
    if (missing.length > 0) {
      throw new ExportStageError(
        `ocr/lines.json is present but does not cover ${missing.length} line(s) the blocks reference`
        + ` (first: ${missing.slice(0, 5).join(', ')}).`
        + ' A partially-populated OCR artifact would mix corrected and uncorrected text silently;'
        + ' re-run the ocr stage over the whole book.',
      );
    }
    for (const [id, t] of corrected) text.set(id, t);
  }

  // The footnotes stage rewrites BLOCK text, not line text, so its output
  // replaces the block's units wholesale.
  const stripped = new Map<string, FootnoteBlockDeletions>();
  if (hasArtifact(runDir, 'footnoteDeletions')) {
    for (const b of readFootnoteDeletions(runDir).blocks) stripped.set(b.blockId, b);
  }

  const blockText = new Map<string, string[]>();
  for (const b of blocks) {
    const marked = stripped.get(b.id);
    if (marked !== undefined) {
      // Integrity: the footnotes stage's rewrite replaces this block WHOLESALE,
      // so it must have been derived from the text that is shipping now. The
      // 2-page end-to-end run caught the violation this guards against: dagger
      // ran against the raw scan, ocr ran too, and every marker-bearing block
      // silently shipped raw text minus markers — OCR corrections discarded.
      // The rewrite must be reproducible: current line text + the recorded
      // deletions must equal the recorded result, or the footnotes artifact is
      // stale against this run directory.
      const base = b.lineIds.map(id => text.get(id)).join('\n');
      const replay = applyFootnoteDeletions(base, marked.applied);
      if (replay.rejected > 0 || replay.text !== marked.text) {
        throw new ExportStageError(
          `footnotes/deletions.json for block ${b.id} does not derive from the current text `
          + `of its lines — it was produced against a different text base (usually: the ocr `
          + `stage ran after footnotes). Re-run the footnotes stage.`,
        );
      }
      // Back to LINES, not one glued unit. The rewrite was computed over the
      // newline-joined base, but everything downstream — joinLines' wrap-hyphen
      // healing, the paragraph ladder — consumes a block as its lines. Shipping
      // `[marked.text]` here (the original bug) made every marker-bearing block
      // a single "line": its embedded `\n`s sailed into the XHTML verbatim and
      // no wrap hyphen in it could ever be examined, which on a footnoted book
      // is nearly every block ("totali-\ntarianism", Kershaw, Aug 3 2026).
      // Footnote deletions never insert newlines, so splitting restores the
      // line structure the deletions were projected onto.
      blockText.set(b.id, marked.text.split('\n'));
      continue;
    }
    const units = b.lineIds.map(id => {
      const t = text.get(id);
      if (t === undefined) {
        throw new ExportStageError(
          `block ${b.id} references line ${id}, which is not in scan/lines.json`,
        );
      }
      return t;
    });
    blockText.set(b.id, units);
  }

  // The vocabulary is built from EVERY line of the book, including the lines of
  // blocks that were excluded from this export. A word is attested by the book,
  // not by the subset a user chose to narrate — and letting an exclusion change
  // how a hyphen elsewhere resolves would make the text depend on the filter.
  const allLines = scan.lines.map(l => text.get(l.id) ?? l.text);

  return { blockText, allLines, lines: scan.lines.map(l => ({ ...l, text: text.get(l.id) ?? l.text })) };
}

/**
 * Build the EPUB metadata from the run directory itself.
 *
 * EPUB requires `dc:identifier`, `dc:title` and `dc:language`; none of the
 * three can simply be omitted. Each is DERIVED, not guessed:
 *
 *  - **identifier**: `urn:sha256:<input hash>`, from run.json. Stable across
 *    re-exports of the same source and different for a different source, which
 *    is the whole job of a publication identifier.
 *  - **title**: the book's own `title` block if it has one, else its first
 *    `chapter` block, else the input filename. The first two are what the
 *    labeller decided the title is, which is a better answer than anything this
 *    function could invent.
 *  - **language**: the tessdata the book was RECOGNIZED with, mapped from
 *    ISO 639-2 to the two-letter form readers expect. This is not a default —
 *    a book OCR'd with `deu` is German, and the pin in run.json is the record
 *    of that decision. A language with no two-letter form keeps its three.
 *
 * A caller with better information passes `metadata` and none of this runs.
 */
export function deriveMetadata(
  runDir: string, blocks: readonly Block[], blockText: ReadonlyMap<string, readonly string[]>,
): EpubMetadata {
  const run = readRun(runDir);

  const titleBlock = blocks.find(b => b.category === 'title')
    ?? blocks.find(b => b.category === 'chapter');
  const fromBlock = titleBlock
    ? (blockText.get(titleBlock.id) ?? []).join(' ').trim()
    : '';
  const fromFile = basename(run.input.path).replace(/\.[^.]+$/, '').trim();

  const lang = run.tesseract.tessdata[0] ?? '';
  return {
    title: fromBlock.length > 0 ? fromBlock : (fromFile.length > 0 ? fromFile : run.runId),
    language: ISO_639_2_TO_1[lang] ?? (lang.length > 0 ? lang : 'und'),
    identifier: `urn:sha256:${run.input.sha256}`,
  };
}

/**
 * Only the languages a pinned tessdata can plausibly carry. Not a general
 * table: an unknown code passes through unchanged rather than being mangled,
 * and a missing one becomes `und`, which is the ISO code that means exactly
 * "undetermined" and is legal in `dc:language`.
 */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it',
  nld: 'nl', dut: 'nl', por: 'pt', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi',
  pol: 'pl', rus: 'ru', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', lat: 'la',
  jpn: 'ja', kor: 'ko', chi_sim: 'zh', chi_tra: 'zh', ara: 'ar', heb: 'he',
  tur: 'tr', hun: 'hu', ron: 'ro', rum: 'ro', ukr: 'uk', cat: 'ca',
};

/**
 * Read the cover file. WHAT it is stays `export/cover.ts`'s question — this
 * hands over bytes and the path they came from, and the magic-byte check runs
 * inside the build, where every caller reaches it.
 */
function readCover(coverPath: string): CoverImage {
  const resolved = resolve(coverPath);
  try {
    return { data: new Uint8Array(readFileSync(resolved)), sourcePath: resolved };
  } catch {
    throw new ExportStageError(`--cover: no such file: ${resolved}`);
  }
}

/** Format the calibration + grouping verdict for the log. */
function verdictBanner(calibration: CalibrationVerdict, result: BuildEpubResult): string {
  const bar = '─'.repeat(72);
  if (!result.grouping.degraded) return result.grouping.message;
  return `\n${bar}\n${result.grouping.message}\n${bar}`
    + `\nCalibration measured: indent — ${calibration.indent.why};`
    + ` gap — ${calibration.gap.why}.\n`;
}

/**
 * Run the export stage over a run directory.
 *
 * Throws when the run directory cannot produce a book. Degrades — loudly, and
 * only for a missing paragraph convention — when the book is merely badly
 * formatted.
 */
export function runExportStage(options: ExportStageOptions): ExportStageResult {
  const { runDir } = options;
  const log = options.log ?? ((m: string) => { console.error(m); });

  const { blocks: labelled, calibration } = readBlocks(runDir);
  if (labelled.length === 0) {
    throw new ExportStageError('blocks/blocks.json contains no blocks — there is no book to export');
  }

  const { blockText: stageText, allLines, lines } = collectBlockText(runDir, labelled);

  // The user's edits land here, above every stage and before grouping — so a
  // retyped heading is the title in the nav, and a relabelled block opens a
  // section the same way a labelled one does.
  const { blocks, blockText, counts } = applyOverrides(labelled, stageText, options.overrides);

  const result = buildEpub({
    blocks,
    lines,
    blockText,
    calibration,
    metadata: options.metadata ?? deriveMetadata(runDir, blocks, blockText),
    attestation: attestationFromLines(allLines),
    exclude: options.exclude,
    ...(options.coverPath ? { cover: readCover(options.coverPath) } : {}),
  });

  // Same atomicity discipline as the JSON artifacts: a half-written EPUB in a
  // synced folder is worse than no EPUB.
  const write = (target: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, result.zip);
    renameSync(tmp, target);
  };

  const canonical = epubPath(runDir);
  write(canonical);
  // The run directory is the contract (PIPELINE.md), so `--output` is a COPY
  // and never a replacement: a book exported to the desktop must still leave
  // the run directory complete enough to re-export from.
  const extra = options.outputPath ? resolve(options.outputPath) : null;
  if (extra !== null && extra !== resolve(canonical)) write(extra);

  writeArtifact(runDir, 'exportExclusions', result.exclusions);

  log(verdictBanner(calibration, result));

  return {
    ...result,
    epubPath: canonical,
    outputPath: extra ?? canonical,
    degraded: result.grouping.degraded,
    overrides: counts,
  };
}
