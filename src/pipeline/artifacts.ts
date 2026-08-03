/**
 * artifacts — the run directory's on-disk schemas, and the only code allowed to
 * read or write them.
 *
 * PIPELINE.md's rule is that Foundry's integration surface is FILES, not
 * function calls: every stage writes its artifact to a documented, stable path
 * and the EPUB is merely the last consumer. That makes these seven files an API
 * with an external consumer (BookForge paints pdf-picker's category layer
 * straight out of `blocks/blocks.json`), and an API needs two properties this
 * module supplies and nothing else does:
 *
 *  1. **A format version per file, checked on every read.** A reader that meets
 *     a version it does not know REFUSES, naming the file and both versions. It
 *     never reads the fields it recognizes and shrugs at the rest — that is the
 *     silent misread PIPELINE.md forbids, and its symptom is a book that came
 *     out subtly wrong months after the change that caused it.
 *  2. **Validation that names the bad field.** A malformed artifact throws
 *     `ArtifactError` saying which file, which index, which field, and what was
 *     expected. No defaults, no coercion, no "missing means false".
 *
 * Writes are atomic (temp file beside the target, then rename). A run directory
 * can sit in a synced folder, and half a JSON file is worse than none.
 *
 * Numbers on disk are in the units the producing stage measured in, and the
 * field comments say which. Two of them are easy to get wrong and are therefore
 * spelled out where they are declared: `bbox` is half-open, PIL crop order,
 * full-page DESKEWED pixels; `gapAbove` is an ADVANCE ratio in line-pitch units
 * (1.0 is normal leading), not an ink gap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Box } from '../scan/bands.js';
import type { BlocksCategory } from '../blocks/encoder.js';
import { BLOCKS_CATEGORIES_V6 } from '../blocks/encoder.js';
import { BLOCK_FORMATION, BLOCK_FORMATION_BEFORE_PARAGRAPH_SPLIT } from '../blocks/formation.js';
import type { Edit, RejectedEdit } from '../ocr/edits.js';
import type { FootnoteDeletion } from '../footnotes/applier.js';

// ── the version table ───────────────────────────────────────────────────────

/**
 * One entry per file in the run directory. `version` is what THIS build writes
 * and the only version it will read.
 *
 * Bump a version when a change is breaking — a field removed, a field's meaning
 * or units changed, a required field added. Additive optional fields do not
 * bump: an old reader ignoring a new optional field is by construction reading
 * the same book. A field is NEVER repurposed; that is a rename plus a bump.
 */
export const ARTIFACTS = {
  run: { path: 'run.json', version: 1 },
  scanPages: { path: 'scan/pages.json', version: 1 },
  scanLines: { path: 'scan/lines.json', version: 1 },
  // 2: `formation` — the segmentation marker — became a required field when the
  // paragraph-aware splitter landed (BLOCKS_TRAINING §13b P0). A required field
  // added is a breaking change by the rule above, and here it is breaking on
  // purpose: a v1 file's blocks were formed by a DIFFERENT rule, so reading one
  // as if it were this build's output is the silent segmentation mix §5 forbids.
  blocks: { path: 'blocks/blocks.json', version: 2 },
  ocrLines: { path: 'ocr/lines.json', version: 1 },
  footnoteDeletions: { path: 'footnotes/deletions.json', version: 1 },
  exportExclusions: { path: 'export/exclusions.json', version: 1 },
} as const;

export type ArtifactName = keyof typeof ARTIFACTS;

/**
 * Which shape belongs to which file. Declared as a map, not left to inference,
 * so `writeArtifact(dir, 'blocks', …)` is checked against `BlocksArtifact`
 * at the call site — a stage writing the wrong shape into the right path is a
 * compile error rather than a reader's problem later.
 */
export interface ArtifactPayloads {
  run: RunArtifact;
  scanPages: ScanPagesArtifact;
  scanLines: ScanLinesArtifact;
  blocks: BlocksArtifact;
  ocrLines: OcrLinesArtifact;
  footnoteDeletions: FootnoteDeletionsArtifact;
  exportExclusions: ExclusionsArtifact;
}

/** The EPUB itself. Not JSON, so not in the table above, but part of the layout. */
export const EPUB_PATH = 'export/book.epub';

// ── errors ──────────────────────────────────────────────────────────────────

/** A run-directory file that is missing, malformed, or of an unreadable version. */
export class ArtifactError extends Error {
  constructor(readonly file: string, readonly detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'ArtifactError';
  }
}

/**
 * Split out from `ArtifactError` because it is the one failure a caller may
 * legitimately want to recognize: an artifact written by a different build of
 * Foundry, which is a "re-run that stage" instruction rather than corruption.
 */
export class ArtifactVersionError extends ArtifactError {
  constructor(file: string, readonly found: unknown, readonly expected: number) {
    super(
      file,
      `formatVersion ${JSON.stringify(found)} cannot be read by this build, which writes and reads `
      + `version ${expected}. Re-run the stage that produces this file; do NOT hand-edit the version.`,
    );
    this.name = 'ArtifactVersionError';
  }
}

// ── shapes ──────────────────────────────────────────────────────────────────

export type StageName = 'scan' | 'blocks' | 'ocr' | 'footnotes' | 'export';
export const STAGE_NAMES: readonly StageName[] = ['scan', 'blocks', 'ocr', 'footnotes', 'export'];

export type StageStatus = 'pending' | 'running' | 'done' | 'failed';
const STAGE_STATUSES: readonly StageStatus[] = ['pending', 'running', 'done', 'failed'];

export interface StageState {
  status: StageStatus;
  /** ISO-8601. */
  startedAt?: string;
  finishedAt?: string;
  /** Present iff status is 'failed'. The message a user sees; never truncated. */
  error?: string;
}

/**
 * `run.json` — the resume/audit record. Everything needed to answer "what
 * produced this book" without re-deriving it: which input, which Tesseract,
 * which adapters, and how far the pipeline got.
 */
export interface RunArtifact {
  formatVersion: number;
  runId: string;
  /** ISO-8601. */
  createdAt: string;
  /** The version of Foundry that created the run directory. */
  foundryVersion: string;
  input: {
    /** As given on the command line — for the audit trail, never for resolution. */
    path: string;
    sha256: string;
    pages: number;
  };
  /**
   * The pin, recorded because the models were trained against exactly this
   * segmenter at exactly this resolution (ARCHITECTURE §5). A run whose
   * Tesseract differs from another run's is not comparable to it.
   */
  tesseract: {
    version: string;
    binarySha256: string;
    /** Language files used, e.g. ['eng']. */
    tessdata: string[];
    dpi: number;
  };
  /** Model ids as they were resolved. The version in the id is load-bearing. */
  models: {
    base?: string;
    blocks?: string;
    ocr?: string;
    footnotes?: string;
  };
  stages: Record<StageName, StageState>;
}

/** One page as it was rendered and straightened. */
export interface ScanPage {
  page: number;
  widthPx: number;
  heightPx: number;
  /** Straightening applied before the boxes below were measured. 0 means none. */
  deskewDeg: number;
  dpi: number;
}

export interface ScanPagesArtifact {
  formatVersion: number;
  pages: ScanPage[];
}

/** One recognized line of the scan. */
export interface ScanLine {
  id: string;
  page: number;
  /** [x0,y0,x1,y1], half-open, PIL crop order, full-page px, DESKEWED. */
  bbox: Box;
  text: string;
  /** Mean word confidence 0-100, or null when the crop produced no words. */
  conf: number | null;
  /** Per-word confidences 0-100, in word order. */
  wordConfidences?: number[];
  /** Which psm read it: 7, or 13 when only the rescue pass could. */
  psm?: number;
}

export interface ScanLinesArtifact {
  formatVersion: number;
  lines: ScanLine[];
}

/**
 * The geometry facts §9d feeds the blocks model as explicit per-block numbers,
 * so it weighs evidence instead of re-deriving arithmetic from coordinates.
 * The same four facts drive the deterministic grouping rules, which is why they
 * are persisted rather than recomputed: the export must be able to explain a
 * paragraph decision from the run directory alone.
 */
export interface BlockGeometry {
  /**
   * The first line's left inset from the book's flush-left margin, in
   * BODY-SIZE units (1.0 == one body line height). 0 is flush.
   */
  firstLineIndent: number;
  /**
   * ADVANCE from the previous block's last line to this block's first line, in
   * LINE-PITCH units: 1.0 is normal leading, ~1.5 is a blank-line paragraph
   * gap. Not an ink gap. `null` when the block opens a page, where there is no
   * previous line to measure from.
   */
  gapAbove: number | null;
  /** Did the previous block's last line stop short of the measure? */
  prevLineShort: boolean;
  /** Does the previous block's last line end in a wrap hyphen? */
  prevEndsWrapHyphen: boolean;
}

/**
 * The model's paragraph-continuation call for this block's junction with its
 * predecessor. Optional because it is a v6 output: a run produced by an earlier
 * adapter simply has no bit, and grouping falls through to geometry.
 */
export interface ContinuesBit {
  value: boolean;
  /** 0..1. Absent means the bit is taken at face value; see grouping.ts. */
  confidence?: number;
}

export interface Block {
  id: string;
  page: number;
  /** [x0,y0,x1,y1], half-open, PIL crop order, full-page px, DESKEWED. */
  bbox: Box;
  /** The `scan/lines.json` ids this block was built from, in reading order. */
  lineIds: string[];
  category: BlocksCategory;
  continues?: ContinuesBit;
  geometry: BlockGeometry;
}

/** Which signal carries paragraph information in this book (§9d decision 5). */
export type ParagraphConvention = 'indent' | 'block' | 'none';

/**
 * One measured signal from calibration, kept whole rather than reduced to a
 * boolean so a wrong verdict can be diagnosed from the artifact instead of by
 * re-running with a debugger.
 */
export interface CalibrationSignal {
  /** Distance between the two clusters, in the signal's own units. */
  separation: number;
  /** Fraction of samples in the upper cluster, 0..1. */
  upperShare: number;
  /** The book-relative threshold this signal would use, in its own units. */
  threshold: number;
  /** Samples the signal was measured over. */
  samples: number;
  fired: boolean;
  /** Why it did not fire, when it did not. */
  why: string;
}

/**
 * The book-level calibration verdict, stored WITH the blocks because it is the
 * frame the block geometry is expressed in: `firstLineIndent` is meaningless
 * without `bodyHeight`, `gapAbove` without `pitch`.
 */
export interface CalibrationVerdict {
  convention: ParagraphConvention;
  /** True iff convention is 'none' — the owner-mandated degradation. */
  degraded: boolean;
  /** Median line ink height in px: the body-size unit. */
  bodyHeight: number;
  /** Median line-to-line advance in px: the pitch unit. */
  pitch: number;
  /** The book's flush-left margin in px, from which indent is measured. */
  flushLeft: number;
  /** The book's body measure in px (flushLeft to the body right edge). */
  measure: number;
  bodyRight: number;
  indent: CalibrationSignal;
  gap: CalibrationSignal;
  /** Human-readable, and the loud one when degraded. */
  message: string;
}

export interface BlocksArtifact {
  formatVersion: number;
  /**
   * The SEGMENTATION MARKER: which rules formed these blocks, composed in the
   * order they ran (`src/blocks/formation.ts`). A prediction is only comparable
   * to a corpus segmented the same way, so the artifact has to say which one it
   * saw — see ARCHITECTURE §5 and BLOCKS_TRAINING §13b.
   */
  formation: string;
  calibration: CalibrationVerdict;
  blocks: Block[];
}

/** One line after the ocr adapter had its say. */
export interface OcrLine {
  id: string;
  /** The corrected text. Equal to the scan text when no edit was accepted. */
  text: string;
  /** Edits that were applied, in application order. */
  edits: Edit[];
  /** Edits the applier refused, with the reason. Harmless, but never silent. */
  rejected: RejectedEdit[];
}

export interface OcrLinesArtifact {
  formatVersion: number;
  lines: OcrLine[];
}

export interface FootnoteBlockDeletions {
  blockId: string;
  /** The marker deletions that landed. */
  applied: FootnoteDeletion[];
  /** How many the subsequence/verbatim guards refused. */
  rejected: number;
  /** The text after the applied deletions. */
  text: string;
}

export interface FootnoteDeletionsArtifact {
  formatVersion: number;
  blocks: FootnoteBlockDeletions[];
}

/**
 * `export/exclusions.json` — exactly what the export dropped, at both
 * granularities, so the EPUB is reproducible from this file alone.
 */
export interface ExclusionsArtifact {
  formatVersion: number;
  /** Categories excluded by request (`--exclude footnote`). */
  excludedCategories: string[];
  /** Block ids excluded by request (pdf-picker's per-box deletion). */
  excludedBlockIds: string[];
  /**
   * Categories the exporter structurally never emits — page furniture and
   * `discard`. Recorded because "why is my running head missing" must be
   * answerable from the artifact, not from the source.
   */
  neverEmittedCategories: string[];
  /** Blocks dropped per excluded category. */
  droppedByCategory: Record<string, number>;
  /** Blocks dropped per never-emitted category. */
  droppedByNeverEmitted: Record<string, number>;
  /** Blocks dropped by id alone (they were not already category-excluded). */
  droppedById: number;
  totalBlocks: number;
  keptBlocks: number;
}

// ── validation helpers ──────────────────────────────────────────────────────

function fail(file: string, detail: string): never {
  throw new ArtifactError(file, detail);
}

function obj(file: string, where: string, v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    fail(file, `${where} must be an object, found ${describe(v)}`);
  }
  return v as Record<string, unknown>;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function arr(file: string, where: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) fail(file, `${where} must be an array, found ${describe(v)}`);
  return v;
}

function str(file: string, where: string, v: unknown): string {
  if (typeof v !== 'string') fail(file, `${where} must be a string, found ${describe(v)}`);
  return v;
}

function optStr(file: string, where: string, v: unknown): string | undefined {
  return v === undefined ? undefined : str(file, where, v);
}

function num(file: string, where: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(file, `${where} must be a finite number, found ${describe(v)} ${JSON.stringify(v)}`);
  }
  return v;
}

function numOrNull(file: string, where: string, v: unknown): number | null {
  return v === null ? null : num(file, where, v);
}

function bool(file: string, where: string, v: unknown): boolean {
  if (typeof v !== 'boolean') fail(file, `${where} must be a boolean, found ${describe(v)}`);
  return v;
}

function strArray(file: string, where: string, v: unknown): string[] {
  return arr(file, where, v).map((e, i) => str(file, `${where}[${i}]`, e));
}

function numArray(file: string, where: string, v: unknown): number[] {
  return arr(file, where, v).map((e, i) => num(file, `${where}[${i}]`, e));
}

function bbox(file: string, where: string, v: unknown): Box {
  const a = arr(file, where, v);
  if (a.length !== 4) fail(file, `${where} must be [x0,y0,x1,y1], found ${a.length} entries`);
  const [x0, y0, x1, y1] = a.map((e, i) => num(file, `${where}[${i}]`, e));
  if (x1 < x0 || y1 < y0) {
    fail(file, `${where} is inverted: [${x0},${y0},${x1},${y1}] — boxes are half-open, x0<=x1 and y0<=y1`);
  }
  return [x0, y0, x1, y1];
}

const LEGAL_CATEGORIES = new Set<string>(BLOCKS_CATEGORIES_V6);

function category(file: string, where: string, v: unknown): BlocksCategory {
  const s = str(file, where, v);
  if (!LEGAL_CATEGORIES.has(s)) {
    fail(file, `${where} is "${s}", which is not a blocks category (${[...LEGAL_CATEGORIES].join(', ')})`);
  }
  return s as BlocksCategory;
}

function oneOf<T extends string>(file: string, where: string, v: unknown, legal: readonly T[]): T {
  const s = str(file, where, v);
  if (!(legal as readonly string[]).includes(s)) {
    fail(file, `${where} is "${s}", expected one of ${legal.join(', ')}`);
  }
  return s as T;
}

/**
 * The version gate. Runs before ANY field is read, so a future format cannot be
 * partially interpreted on its way to a confusing field error.
 */
function checkVersion(file: string, root: Record<string, unknown>, expected: number): void {
  const found = root['formatVersion'];
  if (found !== expected) throw new ArtifactVersionError(file, found, expected);
}

// ── parsers ─────────────────────────────────────────────────────────────────

export function parseRun(text: string, file = ARTIFACTS.run.path): RunArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.run.version);

  const input = obj(file, 'input', root['input']);
  const tess = obj(file, 'tesseract', root['tesseract']);
  const models = obj(file, 'models', root['models']);
  const stagesRaw = obj(file, 'stages', root['stages']);

  /*
   * The `boxes` stage was renamed `blocks` (Aug 2026), pre-release, with no
   * compatibility arm. A run directory written before the rename records the
   * old key, and the loop below would reject it with a bare "stages.blocks must
   * be an object, found undefined" — true, but it names neither the cause nor
   * the fix. Say the rename.
   */
  if (stagesRaw['boxes'] !== undefined && stagesRaw['blocks'] === undefined) {
    fail(
      file,
      'stages.boxes is present and stages.blocks is not. This run directory predates the '
      + 'rename of the `boxes` stage to `blocks`, and it is NOT read with the old name — '
      + 'the artifacts moved too (`boxes/blocks.json` is now `blocks/blocks.json`). '
      + 'Start a fresh run; there is no migration.',
    );
  }

  const stages = {} as Record<StageName, StageState>;
  for (const name of STAGE_NAMES) {
    const s = obj(file, `stages.${name}`, stagesRaw[name]);
    stages[name] = {
      status: oneOf(file, `stages.${name}.status`, s['status'], STAGE_STATUSES),
      startedAt: optStr(file, `stages.${name}.startedAt`, s['startedAt']),
      finishedAt: optStr(file, `stages.${name}.finishedAt`, s['finishedAt']),
      error: optStr(file, `stages.${name}.error`, s['error']),
    };
    if (stages[name].status === 'failed' && stages[name].error === undefined) {
      fail(file, `stages.${name} is 'failed' with no error message — a failure must name itself`);
    }
  }

  return {
    formatVersion: ARTIFACTS.run.version,
    runId: str(file, 'runId', root['runId']),
    createdAt: str(file, 'createdAt', root['createdAt']),
    foundryVersion: str(file, 'foundryVersion', root['foundryVersion']),
    input: {
      path: str(file, 'input.path', input['path']),
      sha256: str(file, 'input.sha256', input['sha256']),
      pages: num(file, 'input.pages', input['pages']),
    },
    tesseract: {
      version: str(file, 'tesseract.version', tess['version']),
      binarySha256: str(file, 'tesseract.binarySha256', tess['binarySha256']),
      tessdata: strArray(file, 'tesseract.tessdata', tess['tessdata']),
      dpi: num(file, 'tesseract.dpi', tess['dpi']),
    },
    models: {
      base: optStr(file, 'models.base', models['base']),
      blocks: optStr(file, 'models.blocks', models['blocks']),
      ocr: optStr(file, 'models.ocr', models['ocr']),
      footnotes: optStr(file, 'models.footnotes', models['footnotes']),
    },
    stages,
  };
}

export function parseScanPages(text: string, file = ARTIFACTS.scanPages.path): ScanPagesArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.scanPages.version);
  const pages = arr(file, 'pages', root['pages']).map((raw, i) => {
    const p = obj(file, `pages[${i}]`, raw);
    return {
      page: num(file, `pages[${i}].page`, p['page']),
      widthPx: num(file, `pages[${i}].widthPx`, p['widthPx']),
      heightPx: num(file, `pages[${i}].heightPx`, p['heightPx']),
      deskewDeg: num(file, `pages[${i}].deskewDeg`, p['deskewDeg']),
      dpi: num(file, `pages[${i}].dpi`, p['dpi']),
    };
  });
  return { formatVersion: ARTIFACTS.scanPages.version, pages };
}

export function parseScanLines(text: string, file = ARTIFACTS.scanLines.path): ScanLinesArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.scanLines.version);
  const seen = new Set<string>();
  const lines = arr(file, 'lines', root['lines']).map((raw, i) => {
    const l = obj(file, `lines[${i}]`, raw);
    const id = str(file, `lines[${i}].id`, l['id']);
    if (seen.has(id)) fail(file, `lines[${i}].id "${id}" is a duplicate — line ids are keys`);
    seen.add(id);
    return {
      id,
      page: num(file, `lines[${i}].page`, l['page']),
      bbox: bbox(file, `lines[${i}].bbox`, l['bbox']),
      text: str(file, `lines[${i}].text`, l['text']),
      // Required, but legitimately null: a crop that produced no words has no
      // mean confidence. Absent is NOT the same thing, and throws.
      conf: numOrNull(file, `lines[${i}].conf`, l['conf']),
      wordConfidences: l['wordConfidences'] === undefined
        ? undefined : numArray(file, `lines[${i}].wordConfidences`, l['wordConfidences']),
      psm: l['psm'] === undefined ? undefined : num(file, `lines[${i}].psm`, l['psm']),
    };
  });
  return { formatVersion: ARTIFACTS.scanLines.version, lines };
}

function parseSignal(file: string, where: string, v: unknown): CalibrationSignal {
  const s = obj(file, where, v);
  return {
    separation: num(file, `${where}.separation`, s['separation']),
    upperShare: num(file, `${where}.upperShare`, s['upperShare']),
    threshold: num(file, `${where}.threshold`, s['threshold']),
    samples: num(file, `${where}.samples`, s['samples']),
    fired: bool(file, `${where}.fired`, s['fired']),
    why: str(file, `${where}.why`, s['why']),
  };
}

export function parseCalibration(file: string, where: string, v: unknown): CalibrationVerdict {
  const c = obj(file, where, v);
  const convention = oneOf<ParagraphConvention>(
    file, `${where}.convention`, c['convention'], ['indent', 'block', 'none'],
  );
  const degraded = bool(file, `${where}.degraded`, c['degraded']);
  if (degraded !== (convention === 'none')) {
    fail(file, `${where}.degraded is ${degraded} but convention is "${convention}" — degraded means and only means 'none'`);
  }
  return {
    convention,
    degraded,
    bodyHeight: num(file, `${where}.bodyHeight`, c['bodyHeight']),
    pitch: num(file, `${where}.pitch`, c['pitch']),
    flushLeft: num(file, `${where}.flushLeft`, c['flushLeft']),
    measure: num(file, `${where}.measure`, c['measure']),
    bodyRight: num(file, `${where}.bodyRight`, c['bodyRight']),
    indent: parseSignal(file, `${where}.indent`, c['indent']),
    gap: parseSignal(file, `${where}.gap`, c['gap']),
    message: str(file, `${where}.message`, c['message']),
  };
}

export function parseBlocks(text: string, file = ARTIFACTS.blocks.path): BlocksArtifact {
  const root = obj(file, 'root', json(file, text));

  /*
   * A v1 file is not merely an older format, it is a DIFFERENT SEGMENTATION:
   * its blocks were formed before the paragraph-aware splitter existed, so its
   * junctions are the ones §13b measured as unreachable (24 body blocks for ~53
   * paragraphs on the Kershaw run) and its block ids key labels that this build
   * would not produce. The bare version error would say "re-run the stage",
   * which is the right instruction for the wrong reason — say which reason, and
   * name both segmentations, because that is the fact a stale prediction has to
   * be identified by later.
   */
  if (root['formatVersion'] === 1 && root['formation'] === undefined) {
    fail(
      file,
      `was written under the ${BLOCK_FORMATION_BEFORE_PARAGRAPH_SPLIT} segmentation, before block `
      + `formation split at paragraph starts. This build forms blocks as ${BLOCK_FORMATION}, `
      + 'so these block ids, and the labels keyed to them, describe a different grouping of the '
      + 'same lines — reading them here would mix two segmentations in one book (ARCHITECTURE §5). '
      + 'Re-run `foundry blocks` against this run directory; scan/lines.json is unaffected and '
      + 'nothing has to be re-scanned. There is no migration.',
    );
  }

  checkVersion(file, root, ARTIFACTS.blocks.version);
  const formation = str(file, 'formation', root['formation']);
  const calibration = parseCalibration(file, 'calibration', root['calibration']);
  const seen = new Set<string>();
  const blocks = arr(file, 'blocks', root['blocks']).map((raw, i) => {
    const b = obj(file, `blocks[${i}]`, raw);
    const at = `blocks[${i}]`;
    const id = str(file, `${at}.id`, b['id']);
    if (seen.has(id)) fail(file, `${at}.id "${id}" is a duplicate — block ids are the exclusion key`);
    seen.add(id);
    const g = obj(file, `${at}.geometry`, b['geometry']);
    const cont = b['continues'];
    let continues: ContinuesBit | undefined;
    if (cont !== undefined) {
      const c = obj(file, `${at}.continues`, cont);
      continues = {
        value: bool(file, `${at}.continues.value`, c['value']),
        confidence: c['confidence'] === undefined
          ? undefined : num(file, `${at}.continues.confidence`, c['confidence']),
      };
      if (continues.confidence !== undefined && (continues.confidence < 0 || continues.confidence > 1)) {
        fail(file, `${at}.continues.confidence is ${continues.confidence}, expected 0..1`);
      }
    }
    return {
      id,
      page: num(file, `${at}.page`, b['page']),
      bbox: bbox(file, `${at}.bbox`, b['bbox']),
      lineIds: strArray(file, `${at}.lineIds`, b['lineIds']),
      category: category(file, `${at}.category`, b['category']),
      continues,
      geometry: {
        firstLineIndent: num(file, `${at}.geometry.firstLineIndent`, g['firstLineIndent']),
        gapAbove: numOrNull(file, `${at}.geometry.gapAbove`, g['gapAbove']),
        prevLineShort: bool(file, `${at}.geometry.prevLineShort`, g['prevLineShort']),
        prevEndsWrapHyphen: bool(file, `${at}.geometry.prevEndsWrapHyphen`, g['prevEndsWrapHyphen']),
      },
    };
  });
  return { formatVersion: ARTIFACTS.blocks.version, formation, calibration, blocks };
}

export function parseOcrLines(text: string, file = ARTIFACTS.ocrLines.path): OcrLinesArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.ocrLines.version);
  const lines = arr(file, 'lines', root['lines']).map((raw, i) => {
    const l = obj(file, `lines[${i}]`, raw);
    const at = `lines[${i}]`;
    return {
      id: str(file, `${at}.id`, l['id']),
      text: str(file, `${at}.text`, l['text']),
      edits: arr(file, `${at}.edits`, l['edits']).map((e, j) => {
        const ed = obj(file, `${at}.edits[${j}]`, e);
        return {
          before: str(file, `${at}.edits[${j}].before`, ed['before']),
          after: str(file, `${at}.edits[${j}].after`, ed['after']),
        };
      }),
      rejected: arr(file, `${at}.rejected`, l['rejected']).map((e, j) => {
        const r = obj(file, `${at}.rejected[${j}]`, e);
        return {
          before: str(file, `${at}.rejected[${j}].before`, r['before']),
          why: str(file, `${at}.rejected[${j}].why`, r['why']),
        };
      }),
    };
  });
  return { formatVersion: ARTIFACTS.ocrLines.version, lines };
}

export function parseFootnoteDeletions(
  text: string, file = ARTIFACTS.footnoteDeletions.path,
): FootnoteDeletionsArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.footnoteDeletions.version);
  const blocks = arr(file, 'blocks', root['blocks']).map((raw, i) => {
    const b = obj(file, `blocks[${i}]`, raw);
    const at = `blocks[${i}]`;
    return {
      blockId: str(file, `${at}.blockId`, b['blockId']),
      applied: arr(file, `${at}.applied`, b['applied']).map((e, j) => {
        const d = obj(file, `${at}.applied[${j}]`, e);
        return {
          before: str(file, `${at}.applied[${j}].before`, d['before']),
          after: str(file, `${at}.applied[${j}].after`, d['after']),
        };
      }),
      rejected: num(file, `${at}.rejected`, b['rejected']),
      text: str(file, `${at}.text`, b['text']),
    };
  });
  return { formatVersion: ARTIFACTS.footnoteDeletions.version, blocks };
}

function countMap(file: string, where: string, v: unknown): Record<string, number> {
  const o = obj(file, where, v);
  const out: Record<string, number> = {};
  for (const k of Object.keys(o)) out[k] = num(file, `${where}.${k}`, o[k]);
  return out;
}

export function parseExclusions(
  text: string, file = ARTIFACTS.exportExclusions.path,
): ExclusionsArtifact {
  const root = obj(file, 'root', json(file, text));
  checkVersion(file, root, ARTIFACTS.exportExclusions.version);
  return {
    formatVersion: ARTIFACTS.exportExclusions.version,
    excludedCategories: strArray(file, 'excludedCategories', root['excludedCategories']),
    excludedBlockIds: strArray(file, 'excludedBlockIds', root['excludedBlockIds']),
    neverEmittedCategories: strArray(file, 'neverEmittedCategories', root['neverEmittedCategories']),
    droppedByCategory: countMap(file, 'droppedByCategory', root['droppedByCategory']),
    droppedByNeverEmitted: countMap(file, 'droppedByNeverEmitted', root['droppedByNeverEmitted']),
    droppedById: num(file, 'droppedById', root['droppedById']),
    totalBlocks: num(file, 'totalBlocks', root['totalBlocks']),
    keptBlocks: num(file, 'keptBlocks', root['keptBlocks']),
  };
}

function json(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(file, `is not valid JSON — ${(e as Error).message}`);
  }
}

// ── file IO ─────────────────────────────────────────────────────────────────

/** Absolute path of one artifact inside a run directory. */
export function artifactPath(runDir: string, name: ArtifactName): string {
  return join(runDir, ARTIFACTS[name].path);
}

/** Absolute path of the exported EPUB. */
export function epubPath(runDir: string): string {
  return join(runDir, EPUB_PATH);
}

function readText(runDir: string, name: ArtifactName): string {
  const p = artifactPath(runDir, name);
  if (!existsSync(p)) {
    throw new ArtifactError(ARTIFACTS[name].path, `not found at ${p} — run the stage that produces it`);
  }
  return readFileSync(p, 'utf8');
}

/**
 * Write one artifact. Atomic by rename, because a run directory may live in a
 * synced folder and a half-written JSON file propagates as corruption.
 *
 * Serialized with two-space indent and a trailing newline: these files are read
 * by humans debugging a book and diffed between runs.
 */
export function writeArtifact<N extends ArtifactName>(
  runDir: string, name: N, value: Omit<ArtifactPayloads[N], 'formatVersion'>,
): void {
  const target = artifactPath(runDir, name);
  mkdirSync(dirname(target), { recursive: true });
  // formatVersion first in the serialization (these files get read by humans),
  // and always OURS: a caller cannot write a version it does not implement.
  const body: Record<string, unknown> = { formatVersion: ARTIFACTS[name].version };
  for (const [k, v] of Object.entries(value)) if (k !== 'formatVersion') body[k] = v;
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

export const readRun = (runDir: string): RunArtifact =>
  parseRun(readText(runDir, 'run'));
export const readScanPages = (runDir: string): ScanPagesArtifact =>
  parseScanPages(readText(runDir, 'scanPages'));
export const readScanLines = (runDir: string): ScanLinesArtifact =>
  parseScanLines(readText(runDir, 'scanLines'));
export const readBlocks = (runDir: string): BlocksArtifact =>
  parseBlocks(readText(runDir, 'blocks'));
export const readOcrLines = (runDir: string): OcrLinesArtifact =>
  parseOcrLines(readText(runDir, 'ocrLines'));
export const readFootnoteDeletions = (runDir: string): FootnoteDeletionsArtifact =>
  parseFootnoteDeletions(readText(runDir, 'footnoteDeletions'));
export const readExclusions = (runDir: string): ExclusionsArtifact =>
  parseExclusions(readText(runDir, 'exportExclusions'));

/** Is this artifact present? For stage skipping — never for choosing a fallback. */
export function hasArtifact(runDir: string, name: ArtifactName): boolean {
  return existsSync(artifactPath(runDir, name));
}
