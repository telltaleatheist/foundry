/**
 * commands — the command surface, and what each command does.
 *
 * The command surface IS the integration contract: BookForge shells into this
 * binary per stage and then reads the run directory (docs/PIPELINE.md). So the
 * shape here — `--run <dir>` everywhere, one artifact per stage at a documented
 * path — is not a CLI convenience, it is the API.
 *
 * Three rules this file is built around, all from docs/ARCHITECTURE.md:
 *
 *  - **No fallbacks (§8).** A missing binary, a missing weight, a missing stage
 *    artifact and an unreadable format version are each an error that names the
 *    missing thing and exits nonzero. Nothing writes a plausible empty artifact
 *    and returns 0.
 *  - **The prompt is built here and sent verbatim to /completion (§4).** Prompt
 *    construction lives in the stage modules (`src/blocks/encoder.ts`,
 *    `src/footnotes/prompt.ts`); this file wires them to the server and never
 *    reshapes what they produce.
 *  - **Stages are resumable (PIPELINE).** Each stage reads the previous stage's
 *    artifact off disk and writes its own. A stage that fails leaves everything
 *    earlier intact, which is what makes `convert` safe to re-run.
 *
 * WHAT IS NOT WIRED YET, and why the errors say so rather than pretending:
 *
 *  - **The weights are not published.** `src/models/catalog.ts` is empty on
 *    purpose, so `blocks`/`ocr`/`footnotes` build their real inputs and then stop
 *    at model resolution with the not-published message. An explicit
 *    `--base-model` / `--adapter` path overrides the catalog for anyone holding
 *    a local GGUF — an override, not a fallback.
 *  - **The ocr prompt was MOVED, not re-typed.** `src/ocr/prompt.ts` carries the
 *    trained-against system prompt, verified byte-identical against
 *    BookForgeApp's `tools/galley/build-dataset.py` by
 *    `tools/crosscheck-ocr-prompt.mjs` (recorded in test/ocr/CROSSCHECK.md).
 *    The stage ships with the per-word guard (`src/ocr/guard.ts`) always on —
 *    it is part of the measured configuration, not an option.
 *  - **PDF rasterization is not built.** `scan` takes a directory of rendered
 *    page images. BookForge already has a mupdf render pool and supplies them;
 *    standalone PDF input is the next milestone. There is no half-measure here —
 *    a wrong dpi silently invalidates every model in the pipeline (§5).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  flag,
  formatOptions,
  optionalString,
  parseArgs,
  requireString,
  stringList,
  UsageError,
  type OptionSpec,
  type ParsedArgs,
} from './args.js';
import {
  BLOCKS_STOP,
  blocksVersionFor,
  encodeBook,
  parseAnswer,
  toRawPrompt,
  type BlocksCategory,
  type BlocksVersion,
  type PageDimension,
  type TextBlock,
} from './blocks/encoder.js';
import { applyFootnoteDeletions, planFootnotes, type FootnoteDeletion } from './footnotes/applier.js';
import { FOOTNOTES_STOP } from './footnotes/prompt.js';
import { applyEdits, deriveEdits } from './ocr/edits.js';
import { ocrWordGuard } from './ocr/guard.js';
import { extractOcrAnswer, OCR_STOP, toOcrRawPrompt } from './ocr/prompt.js';
import {
  FOUNDRY_MODELS,
  requireDefaultModel,
  type FoundryAdapter,
  type FoundryModelDef,
} from './models/catalog.js';
import { downloadVerified, sha256File } from './models/download.js';
import { ensureModelsDir, modelFilePath, modelsDir } from './models/paths.js';
import { calibrate } from './paragraphs/calibration.js';
import { computeBlockGeometry } from './paragraphs/geometry.js';
import {
  ARTIFACTS,
  artifactPath,
  hasArtifact,
  readBlocks,
  readRun,
  readScanLines,
  readScanPages,
  STAGE_NAMES,
  writeArtifact,
  type Block,
  type BlockGeometry,
  type FootnoteBlockDeletions,
  readOcrLines,
  type OcrLine,
  type CalibrationVerdict,
  type RunArtifact,
  type ScanLine,
  type ScanPage,
  type StageName,
  type StageState,
} from './pipeline/artifacts.js';
import { runExportStage, type BlockOverride, type OverrideRequest } from './pipeline/export-stage.js';
import { applyDeskew, processPage, type Box } from './scan/bands.js';
import { readPgm } from './scan/pgm.js';
import { OCR_DPI, recognizeBands, resolveTesseract } from './scan/tesseract.js';
import { resolveLlamaServer } from './serve/llama-binary.js';
import { LlamaServer } from './serve/llama-server.js';
import { versionString } from './version.js';

// ═════════════════════════════════════════════════════════════════════════════
// Options
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Flags every command accepts.
 *
 * Every one of these is an OVERRIDE of normal resolution, and none of them turns
 * a missing thing into a working thing: a `--tesseract` pointing at the wrong
 * version is still an error, because the models are trained on one specific
 * Tesseract's segmentation (ARCHITECTURE §5), and a `--base-model` pointing at
 * the wrong GGUF is a model mismatch, not a rescue.
 */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'llama-server',
    type: 'string',
    placeholder: '<path>',
    describe: 'Use this llama-server binary instead of the bundled one (BookForge passes its own).',
  },
  {
    name: 'tesseract',
    type: 'string',
    placeholder: '<path>',
    describe: 'Use this tesseract binary instead of the bundled one. Still version-checked.',
  },
  {
    name: 'models-dir',
    type: 'string',
    placeholder: '<path>',
    describe: 'Directory holding the base model and adapters. Default: platform data dir.',
  },
  {
    name: 'base-model',
    type: 'string',
    placeholder: '<file.gguf>',
    describe: 'Use this base-model GGUF instead of the catalogued one.',
  },
  {
    name: 'adapter',
    type: 'string',
    placeholder: '<file.gguf>',
    describe: "This stage's LoRA adapter GGUF. The version in its FILENAME picks the prompt format.",
  },
  {
    name: 'context',
    type: 'string',
    placeholder: '<tokens>',
    describe: `llama-server -c. Default ${1024 * 16}. Size against the corpus; truncation is silent.`,
  },
  {
    name: 'gpu-layers',
    type: 'string',
    placeholder: '<n>',
    describe: 'llama-server -ngl. All or none: default 99 on Apple Silicon, 0 elsewhere.',
  },
  { name: 'verbose', type: 'boolean', describe: 'Echo llama-server log lines.' },
  { name: 'help', short: 'h', type: 'boolean', describe: 'Show help for this command.' },
];

const RUN_DIR: OptionSpec = {
  name: 'run',
  type: 'string',
  placeholder: '<dir>',
  describe: 'The run directory. Every stage reads and writes artifacts here (docs/PIPELINE.md).',
};

const PAGES_DIR: OptionSpec = {
  name: 'pages',
  type: 'string',
  placeholder: '<dir>',
  describe: 'Directory of page images (binary PGM, rendered at 200 dpi), one file per page.',
};

const OUTPUT_EPUB: OptionSpec = {
  name: 'output',
  short: 'o',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'Where to write the EPUB.',
};

const EXCLUDE: OptionSpec = {
  name: 'exclude',
  type: 'string',
  placeholder: '<category>',
  describe: 'Drop every block of this category. Repeatable.',
  multiple: true,
};

const EXCLUDE_IDS: OptionSpec = {
  name: 'exclude-ids',
  type: 'string',
  placeholder: '<file>',
  describe: 'File of block ids to drop, one per line (BookForge writes this from pdf-picker).',
};

const OVERRIDES: OptionSpec = {
  name: 'overrides',
  type: 'string',
  placeholder: '<file>',
  describe: 'JSON of per-block text/category edits: { "blocks": [{ "id", "text?", "category?" }] }.',
};

export interface Command {
  name: string;
  /** One line, shown in the top-level command list. */
  summary: string;
  /** Argument shape for the usage line. */
  usage: string;
  /** Full prose shown by `foundry <cmd> --help`. */
  detail: string;
  /** Options beyond the global ones. */
  options?: readonly OptionSpec[];
  /** Positional arguments, for the help block. */
  positionals?: readonly { name: string; describe: string }[];
  /** What the command does. Throws on any failure; never returns on error. */
  run: (args: ParsedArgs) => Promise<void>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Run-directory artifacts
//
// The shapes, their validation and the atomic writes all live in
// `src/pipeline/artifacts.ts`, which PIPELINE.md makes the only module allowed
// to read or write the run directory. Nothing in this file re-declares a field
// name or hand-rolls a JSON write: two spellings of `blocks/blocks.json` is the
// same failure as two copies of a prompt format, one directory down.
//
// What lives here is stage BOOKKEEPING — creating the run record, marking a
// stage running, done or failed — because that is a property of how the CLI
// executes, not of the format.
// ═════════════════════════════════════════════════════════════════════════════

/** Progress and diagnostics go to stderr; command RESULTS go to stdout. */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A block as this file carries it while it is being built.
 *
 * The artifact's `Block` deliberately holds no text — text belongs to the lines,
 * and a block that carried its own copy would be a second source of truth for
 * the words in the book. In memory it is convenient to have both, so this type
 * is the artifact's block plus the joined text and the size facts the encoder
 * needs, and `toArtifactBlock` projects it back down on the way to disk.
 */
interface WorkingBlock {
  id: string;
  page: number;
  bbox: Box;
  lineIds: string[];
  text: string;
  lineCount: number;
  charCount: number;
  /** Median line ink height in px — the type-size proxy the encoder normalises. */
  fontSizePx: number;
  /** Mean word confidence over the block's lines, 0-100, or null. */
  conf: number | null;
  category?: BlocksCategory;
  geometry?: BlockGeometry;
}

function toArtifactBlock(b: WorkingBlock): Block {
  if (!b.category || !b.geometry) {
    throw new Error(`block ${b.id} is missing its category or geometry — refusing to write a partial artifact`);
  }
  return {
    id: b.id,
    page: b.page,
    bbox: b.bbox,
    lineIds: b.lineIds,
    category: b.category,
    geometry: b.geometry,
  };
}

/** Every stage 'pending' — the shape run.json is born with. */
function pendingStages(): Record<StageName, StageState> {
  const stages = {} as Record<StageName, StageState>;
  for (const name of STAGE_NAMES) stages[name] = { status: 'pending' };
  return stages;
}

/**
 * The run record, or an error saying which stage creates it.
 *
 * `run.json` is written by `scan`, because only `scan` knows the two things the
 * record must carry from birth: the input's hash and the Tesseract that read it.
 * A later stage against a directory without one is not a directory to improvise
 * into — it is a run that never started.
 */
function loadRun(runDir: string): RunArtifact {
  if (!hasArtifact(runDir, 'run')) {
    throw new Error(
      `No run record at ${artifactPath(runDir, 'run')}.\n`
      + `run.json is written by \`foundry scan\`, which is the only stage that `
      + `knows the input hash and the Tesseract version the record has to carry. `
      + `Run scan against this directory first.`,
    );
  }
  return readRun(runDir);
}

function saveRun(runDir: string, run: RunArtifact): void {
  writeArtifact(runDir, 'run', run);
}

/**
 * Run one stage, recording what happened either way.
 *
 * A failure is written into run.json and then RETHROWN: the record exists so a
 * resumed run knows where it stopped, and the rethrow exists so the process
 * exits nonzero. Earlier artifacts are untouched — that is the whole point of a
 * per-stage record, and it is what makes `convert` safe to re-run.
 *
 * The run record has to exist already (see `loadRun`), except for `scan`, which
 * creates it before calling this.
 */
async function withStageRecord(
  runDir: string,
  stage: StageName,
  body: () => Promise<void>,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const mark = (state: StageState): void => {
    try {
      const run = loadRun(runDir);
      run.stages[stage] = state;
      saveRun(runDir, run);
    } catch {
      // The record could not be updated — an unwritable directory, or a scan
      // that failed before it wrote one. The original failure is the news.
    }
  };

  mark({ status: 'running', startedAt });
  try {
    await body();
  } catch (err) {
    mark({
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  mark({ status: 'done', startedAt, finishedAt: new Date().toISOString() });
}

/** Record which model answered for a stage. The version in the id is the point. */
function recordModel(runDir: string, stage: 'blocks' | 'ocr' | 'footnotes', plan: ModelPlan): void {
  const run = loadRun(runDir);
  run.models[stage] = plan.adapterId;
  run.models.base = plan.baseId;
  saveRun(runDir, run);
}

// ═════════════════════════════════════════════════════════════════════════════
// scan
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Sort page files the way a human numbers pages: `p2.pgm` before `p10.pgm`.
 *
 * Hand-rolled rather than `Intl.Collator({numeric:true})` because page ORDER is
 * the spine of every artifact downstream — a run whose pages are ordered by
 * whatever ICU the host build happens to carry is a run whose block ids mean
 * something different on another machine.
 */
function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d/.test(ax[i]!);
    const bn = /^\d/.test(bx[i]!);
    if (an && bn) {
      const d = Number(ax[i]) - Number(bx[i]);
      if (d !== 0) return d;
      continue;
    }
    if (ax[i] !== bx[i]) return ax[i]! < bx[i]! ? -1 : 1;
  }
  return ax.length - bx.length;
}

/**
 * Where `vendor/tesseract` is, for THIS way of running the program.
 *
 * Two spellings of "next to this program", checked in order, and neither of
 * them substitutes a different Tesseract the way a PATH lookup would:
 *
 *  - **Compiled** (`bun build --compile`): `process.execPath` is the foundry
 *    binary and `vendor/` sits beside it in the install.
 *  - **From source** (`bun run src/cli.ts`): `process.execPath` is bun, which is
 *    somewhere else entirely, so the repo root comes from this module's own
 *    location — which in a compiled binary is a virtual path that does not exist
 *    on disk, and is simply not offered.
 *
 * This has to be passed in explicitly rather than left to `resolveTesseract`'s
 * own default, because that default is module-relative and therefore resolves
 * inside the compiled binary's virtual filesystem — the pin would read as
 * missing on every packaged install.
 *
 * When nothing is found the FIRST candidate is returned anyway, so the error
 * that follows names the path a packager needs to fill.
 */
function vendorTesseractDir(): string {
  const beside = path.dirname(process.execPath);
  const candidates = [
    path.join(beside, 'vendor', 'tesseract'),
    // One level up, which covers both a `bin/foundry` + `vendor/` install and a
    // compiled binary sitting in the checkout's own `dist/`. Still "next to this
    // program", still not a search.
    path.join(beside, '..', 'vendor', 'tesseract'),
  ];
  try {
    const moduleDir = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(moduleDir, '..');
    if (fs.statSync(repoRoot).isDirectory()) {
      candidates.push(path.join(repoRoot, 'vendor', 'tesseract'));
    }
  } catch {
    /* compiled build: no real directory to derive */
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return candidates[0]!;
}

function listPageImages(pagesDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(pagesDir);
  } catch {
    throw new Error(`No such directory: ${pagesDir} (--pages)`);
  }
  const pages = entries.filter((f) => f.toLowerCase().endsWith('.pgm')).sort(naturalCompare);
  if (pages.length === 0) {
    throw new Error(
      `No .pgm page images in ${pagesDir}.\n`
      + `foundry does not rasterize PDFs yet: it reads page renders produced at `
      + `${OCR_DPI} dpi as binary PGM (P5). BookForge supplies these from its mupdf `
      + `render pool; see README "Page input". A render at any other dpi silently `
      + `changes Tesseract's segmentation and invalidates every model downstream.`,
    );
  }
  return pages;
}

/** sha256 of a list of files, in order — the run's input identity. */
function hashFiles(dir: string, files: readonly string[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(path.join(dir, file)));
  return hash.digest('hex');
}

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function runScan(args: ParsedArgs): Promise<void> {
  const pagesDir = path.resolve(
    requireString(args, 'pages', 'the directory of page images to segment'),
  );
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to write into'));

  const files = listPageImages(pagesDir);
  const tess = await resolveTesseract({
    binaryPath: optionalString(args, 'tesseract'),
    vendorDir: vendorTesseractDir(),
  });
  log(`scan: ${files.length} pages, tesseract ${tess.version} (${tess.platform}) at ${OCR_DPI} dpi`);

  // The input hash is taken BEFORE any work, so the run record can exist from
  // the first moment and a failure mid-scan is recorded rather than inferred.
  const inputSha = hashFiles(pagesDir, files);

  fs.mkdirSync(runDir, { recursive: true });
  let run: RunArtifact;
  if (hasArtifact(runDir, 'run')) {
    run = readRun(runDir);
    if (run.input.sha256 !== inputSha) {
      // Re-scanning the same directory is normal. Re-scanning DIFFERENT pages
      // into it is not: every artifact already there is keyed to page indices
      // that no longer mean the same thing, and the mismatch would only surface
      // as a book with the wrong text under the right labels.
      throw new Error(
        `${artifactPath(runDir, 'run')} was built from different input.\n`
        + `  recorded sha256 ${run.input.sha256} (${run.input.pages} pages, ${run.input.path})\n`
        + `  this input       ${inputSha} (${files.length} pages, ${pagesDir})\n`
        + `Page indices are the key every downstream artifact uses, so a run `
        + `directory belongs to one set of pages. Use a new run directory.`,
      );
    }
    run.input = { path: pagesDir, sha256: inputSha, pages: files.length };
  } else {
    run = {
      formatVersion: ARTIFACTS.run.version,
      runId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      foundryVersion: versionString(),
      input: { path: pagesDir, sha256: inputSha, pages: files.length },
      tesseract: {
        version: tess.version,
        binarySha256: sha256Of(tess.binary),
        tessdata: [tess.lang],
        dpi: OCR_DPI,
      },
      models: {},
      stages: pendingStages(),
    };
  }
  run.tesseract = {
    version: tess.version,
    binarySha256: sha256Of(tess.binary),
    tessdata: [tess.lang],
    dpi: OCR_DPI,
  };
  saveRun(runDir, run);

  await withStageRecord(runDir, 'scan', async () => {
    const pages: ScanPage[] = [];
    const lines: ScanLine[] = [];

    for (let index = 0; index < files.length; index++) {
      const source = files[index]!;
      const raster = readPgm(new Uint8Array(fs.readFileSync(path.join(pagesDir, source))), source);
      const bands = processPage(raster, index);
      // The bands were measured on the DESKEWED raster, so the crops must be
      // taken from it too. processPage returns the angle it used; a nonzero one
      // means the geometry below is in straightened pixels.
      const straightened = bands.deskewDeg === 0 ? raster : applyDeskew(raster, bands.deskewDeg);
      const recognized = await recognizeBands(tess, straightened, bands.bands, index);

      pages.push({
        page: index,
        widthPx: bands.widthPx,
        heightPx: bands.heightPx,
        deskewDeg: bands.deskewDeg,
        dpi: OCR_DPI,
      });
      recognized.lines.forEach((line, i) => {
        lines.push({
          id: lineId(index, i),
          page: index,
          bbox: line.bbox,
          text: line.text,
          conf: line.conf,
          psm: line.psm,
        });
      });
      log(
        `  page ${index + 1}/${files.length} ${source}: ${recognized.lines.length} lines`
        + `${recognized.rescued ? `, ${recognized.rescued} rescued` : ''}`
        + `${bands.deskewDeg ? `, deskew ${bands.deskewDeg.toFixed(2)}°` : ''}`
        + `${bands.stats.coverageMissed > 0.005 ? `, COVERAGE ${(bands.stats.coverageMissed * 100).toFixed(1)}% missed` : ''}`,
      );
    }

    writeArtifact(runDir, 'scanPages', { pages });
    writeArtifact(runDir, 'scanLines', { lines });
    log(`scan: wrote ${ARTIFACTS.scanPages.path} and ${ARTIFACTS.scanLines.path} — ${lines.length} lines`);
  });
}

/** `p0007l0012` — stable, sortable, and it says what it is. */
function lineId(page: number, index: number): string {
  return `p${String(page).padStart(4, '0')}l${String(index).padStart(4, '0')}`;
}

function blockId(page: number, index: number): string {
  return `p${String(page).padStart(4, '0')}b${String(index).padStart(3, '0')}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Block formation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Group a page's lines into blocks.
 *
 * **This grouping is PROVISIONAL, it is recorded as `gap-v0` in
 * `blocks/blocks.json`, and it is not the grouping the blocks model was trained
 * against.** The training corpus used Tesseract's own paragraph identity (the
 * `blockNum:parNum` key, "split-only block formation" in the v4 notes), which
 * the band path cannot produce: it hands Tesseract one crop per line under
 * `--psm 7`, so there is no page-level layout pass to ask.
 *
 * That matters enough to name loudly rather than bury, because it is precisely
 * the failure ARCHITECTURE §5 is about — a different segmentation is a different
 * input distribution, and the damage reads as a bad model. It is recorded in the
 * artifact so a prediction made under it can be identified later.
 *
 * The rule itself is deliberately dull: a new block starts when the vertical gap
 * to the previous line exceeds `GAP_FACTOR` of the page's median line height, or
 * when the line does not overlap the running block horizontally at all (a column
 * change). Reading order is the order the bands came in, which is the band
 * segmenter's column-major order.
 */
const BLOCK_FORMATION = 'gap-v0';
const GAP_FACTOR = 0.8;

function formBlocks(pages: readonly ScanPage[], lines: readonly ScanLine[]): WorkingBlock[] {
  const byPage = new Map<number, ScanLine[]>();
  for (const line of lines) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page)!.push(line);
  }

  const blocks: WorkingBlock[] = [];
  for (const page of pages) {
    const pageLines = byPage.get(page.page) ?? [];
    if (pageLines.length === 0) continue;

    const heights = pageLines.map((l) => l.bbox[3] - l.bbox[1]).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
    const threshold = GAP_FACTOR * medianHeight;

    let index = 0;
    let current: ScanLine[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      blocks.push(makeBlock(page.page, index++, current));
      current = [];
    };

    for (const line of pageLines) {
      const prev = current[current.length - 1];
      if (prev) {
        const gap = line.bbox[1] - prev.bbox[3];
        const overlaps = line.bbox[0] < blockRight(current) && line.bbox[2] > blockLeft(current);
        if (gap > threshold || !overlaps) flush();
      }
      current.push(line);
    }
    flush();
  }
  return blocks;
}

const blockLeft = (lines: readonly ScanLine[]): number => Math.min(...lines.map((l) => l.bbox[0]));
const blockRight = (lines: readonly ScanLine[]): number => Math.max(...lines.map((l) => l.bbox[2]));

function makeBlock(page: number, index: number, lines: ScanLine[]): WorkingBlock {
  const text = lines.map((l) => l.text).join('\n');
  const confs = lines.map((l) => l.conf).filter((c): c is number => c !== null);
  return {
    id: blockId(page, index),
    page,
    bbox: [
      blockLeft(lines),
      Math.min(...lines.map((l) => l.bbox[1])),
      blockRight(lines),
      Math.max(...lines.map((l) => l.bbox[3])),
    ],
    lineIds: lines.map((l) => l.id),
    text,
    lineCount: lines.length,
    charCount: text.length,
    fontSizePx: medianOf(lines.map((l) => l.bbox[3] - l.bbox[1])),
    conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
  };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Blocks in the shape `src/blocks/encoder.ts` reads. Field names are contract. */
function toTextBlocks(blocks: readonly WorkingBlock[]): TextBlock[] {
  return blocks.map((b) => ({
    id: b.id,
    page: b.page,
    x: b.bbox[0],
    y: b.bbox[1],
    width: b.bbox[2] - b.bbox[0],
    height: b.bbox[3] - b.bbox[1],
    text: b.text,
    font_size: b.fontSizePx,
    font_name: 'ocr',
    char_count: b.charCount,
    region: '',
    category_id: b.category ?? '',
    line_count: b.lineCount,
    is_ocr: true,
    // The encoder wants 0-1; Tesseract reports 0-100.
    ocr_confidence: b.conf === null ? 1 : b.conf / 100,
    line_boxes: [],
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// Models
// ═════════════════════════════════════════════════════════════════════════════

interface ModelPlan {
  basePath: string;
  baseId: string;
  /**
   * The LoRA adapter, or null for a MERGED fine-tune given as `--base-model`
   * with no `--adapter`.
   *
   * Null is not "run without a model". It is the case where the weights being
   * pointed at already contain the tune — which is what every model in this
   * family is today, before the base+adapter split exists — and the caller has
   * said so by naming one file and not two. Requests then carry no adapter, and
   * the server loads none, so nothing is silently half-applied.
   */
  adapterPath: string | null;
  /** The id the prompt version is read out of — a catalog id or a filename. */
  adapterId: string;
}

function requireGgufFile(file: string, what: string): string {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${what} does not exist: ${resolved}`);
  }
  return resolved;
}

/**
 * Where a stage's weights come from, or an error saying why there are none.
 *
 * Two sources, in this order, and there is no third:
 *   1. `--base-model` / `--adapter` — explicit GGUF paths. An OVERRIDE, for
 *      someone holding weights of their own, and the whole reason the plumbing
 *      below is reachable today.
 *   2. the catalog (`src/models/catalog.ts`) + the models directory.
 *
 * With the catalog empty, (2) throws the not-published message from
 * `requireDefaultModel`, which says the weights are not on HuggingFace rather
 * than that a file is missing from this machine — different problems, different
 * remedies, and conflating them sends people searching their own disk for
 * something nobody has uploaded.
 */
function resolveStageModels(args: ParsedArgs, stage: FoundryAdapter): ModelPlan {
  const dir = optionalString(args, 'models-dir');

  const explicitBase = optionalString(args, 'base-model');
  const explicitAdapter = optionalString(args, 'adapter');

  const base = explicitBase
    ? { path: requireGgufFile(explicitBase, '--base-model'), id: path.basename(explicitBase) }
    : catalogued('base', dir);

  if (explicitAdapter) {
    return {
      basePath: base.path,
      baseId: base.id,
      adapterPath: requireGgufFile(explicitAdapter, '--adapter'),
      adapterId: path.basename(explicitAdapter),
    };
  }

  // An explicit base with no adapter is a merged fine-tune, and the prompt
  // version is then read out of the BASE's filename — which is the same rule as
  // always: the version lives in the name of whatever weights answer the
  // request (ARCHITECTURE §3).
  if (explicitBase) {
    return { basePath: base.path, baseId: base.id, adapterPath: null, adapterId: base.id };
  }

  const adapter = catalogued(stage, dir);
  return {
    basePath: base.path,
    baseId: base.id,
    adapterPath: adapter.path,
    adapterId: adapter.id,
  };
}

function catalogued(role: 'base' | FoundryAdapter, dir: string | undefined): { path: string; id: string } {
  const def = requireDefaultModel(role);
  const file = modelFilePath(def.id, dir);
  if (!fs.existsSync(file)) {
    throw new Error(
      `The ${role} model ${def.id} is catalogued but not on disk at ${file}. `
      + `Run \`foundry models pull\`.`,
    );
  }
  return { path: file, id: def.id };
}

/** What weights are about to answer, said plainly enough to catch a mistake. */
function describePlan(plan: ModelPlan): string {
  return plan.adapterPath
    ? `adapter ${plan.adapterId} on base ${plan.baseId}`
    : `merged model ${plan.baseId}, no adapter applied`;
}

const DEFAULT_CONTEXT = 1024 * 16;

function intOption(args: ParsedArgs, name: string, fallback: number): number {
  const raw = optionalString(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} takes a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Build the server for one stage.
 *
 * One base, one adapter, named for the stage. When all three adapters exist a
 * `convert` should hold ONE server carrying all three (ARCHITECTURE §3) — that
 * is a one-line change here and is deliberately not written yet, because no
 * stage past `scan` can currently run at all and untested optimisation of an
 * unreachable path is not a saving.
 */
function buildServer(args: ParsedArgs, stage: FoundryAdapter, plan: ModelPlan): LlamaServer {
  const binaryPath = resolveLlamaServer(optionalString(args, 'llama-server'));
  const verbose = flag(args, 'verbose');
  return new LlamaServer({
    binaryPath,
    basePath: plan.basePath,
    adapters: plan.adapterPath ? [{ name: stage, path: plan.adapterPath }] : [],
    contextSize: intOption(args, 'context', DEFAULT_CONTEXT),
    nGpuLayers: intOption(
      args,
      'gpu-layers',
      process.platform === 'darwin' && process.arch === 'arm64' ? 99 : 0,
    ),
    ...(verbose ? { onLog: (line: string) => log(`  [llama] ${line}`) } : {}),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// blocks
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Everything the model stages read out of the scan: the pages, the lines, the
 * blocks formed from them, and the book's paragraph calibration.
 *
 * Calibration runs HERE, before anything is classified, because it is
 * label-free by design (it sees line geometry, not categories) and because the
 * blocks prompt is fed geometry expressed in the calibrated frame. It is
 * recomputed per stage rather than cached: it is one pass over line boxes, and
 * a cached verdict is one more thing that can be stale against the lines.
 */
function readScanAndForm(runDir: string): {
  pages: ScanPage[];
  lines: ScanLine[];
  blocks: WorkingBlock[];
  calibration: CalibrationVerdict;
} {
  const pages = readScanPages(runDir).pages;
  const lines = readScanLines(runDir).lines;
  const blocks = formBlocks(pages, lines);
  const calibration = calibrate(lines.map((l) => ({ page: l.page, bbox: l.bbox })));
  const geometry = computeBlockGeometry(blocks, lines, calibration);
  for (const block of blocks) {
    const g = geometry.get(block.id);
    if (!g) throw new Error(`block ${block.id} got no geometry — computeBlockGeometry skipped it`);
    block.geometry = g;
  }
  return { pages, lines, blocks, calibration };
}

async function runBlocks(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to read and write'));
  loadRun(runDir);

  await withStageRecord(runDir, 'blocks', async () => {
    const { pages, lines, blocks, calibration } = readScanAndForm(runDir);
    log(
      `blocks: ${blocks.length} blocks formed from ${lines.length} lines over `
      + `${pages.length} pages (formation ${BLOCK_FORMATION})`,
    );
    // The one sanctioned degradation in the pipeline, and it is REPORTED rather
    // than absorbed: a book with no detectable paragraph convention still
    // exports, with few or no breaks (PIPELINE.md, §9d decision 5).
    log(
      `blocks: paragraph convention "${calibration.convention}"`
      + `${calibration.degraded ? ' — DEGRADED: ' : ' — '}${calibration.message}`,
    );

    // Model resolution happens HERE, after the run directory has been read and
    // the blocks formed, so an operator sees their run is sound before being
    // told the weights are missing — and so the prompt-format version, which is
    // read out of the model id, is known before anything is encoded.
    const plan = resolveStageModels(args, 'blocks');
    const version: BlocksVersion = blocksVersionFor(plan.adapterId);
    log(`blocks: ${describePlan(plan)} → prompt format v${version}`);

    const dimensions: PageDimension[] = [];
    for (const page of pages) dimensions[page.page] = { width: page.widthPx, height: page.heightPx };
    const encoded = encodeBook(toTextBlocks(blocks), dimensions, {
      version,
      totalPages: pages.length,
    });
    log(`blocks: ${encoded.length} page prompts encoded`);

    const server = buildServer(args, 'blocks', plan);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    try {
      for (const page of encoded) {
        const answer = await server.complete({
          // VERBATIM: the encoder produced the final string, including the empty
          // <think> block the training template inserts (ARCHITECTURE §4).
          prompt: toRawPrompt(page),
          adapter: plan.adapterPath ? 'blocks' : null,
          stop: [BLOCKS_STOP],
        });
        const labels = parseAnswer(answer, page.blockIds, version);
        for (const [id, category] of labels) {
          const block = byId.get(id);
          if (block) block.category = category;
        }
        log(`  page ${page.page + 1}/${encoded.length}: ${labels.size}/${page.blockIds.length} blocks labelled`);
      }
    } finally {
      await server.stop();
    }

    // A block with no category is a block the model did not answer for, and
    // there is no safe stand-in: `discard` would drop real text out of the book
    // and `body` would narrate a running head. So the artifact is NOT written —
    // scan's output is untouched, and the stage can be re-run (with a longer
    // --context, which is the usual cause: a truncated prompt loses the END of
    // the block list, so the model never sees the blocks it failed to answer for).
    const unlabelled = blocks.filter((b) => !b.category);
    if (unlabelled.length) {
      throw new Error(
        `The blocks model did not label ${unlabelled.length} of ${blocks.length} blocks, `
        + `starting with ${unlabelled.slice(0, 5).map((b) => b.id).join(', ')}.\n`
        + `blocks/blocks.json was NOT written: every block needs a category, and `
        + `there is no safe default — 'discard' would silently drop text and 'body' `
        + `would narrate furniture. Re-run, and if a page repeats, check --context: `
        + `a truncated prompt loses the tail of the block list.`,
      );
    }

    writeArtifact(runDir, 'blocks', {
      calibration,
      blocks: blocks.map(toArtifactBlock),
    });
    recordModel(runDir, 'blocks', plan);
    log(`blocks: wrote ${ARTIFACTS.blocks.path} — ${blocks.length} labelled blocks`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ocr
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One line through the ship configuration: model → per-word guard → edit
 * derivation → applier round-trip. The model answers with a whole corrected
 * line (free text — it CAN invent a word, and nothing in the wire format stops
 * it), so the artifact is only ever built from an output that survived the
 * guard AND could be expressed as contract-legal edits.
 *
 * Rejection is never silent and never fatal: the line ships unchanged and the
 * artifact records why. That is the measured ship configuration (checkpoint-2
 * scoring, Aug 1 2026), not a fallback: EN degraded rows 37 → 15 with CER
 * improving, DE degraded 52 → 29.
 */
function repairLine(id: string, src: string, out: string): OcrLine {
  if (out === src) return { id, text: src, edits: [], rejected: [] };

  const verdict = ocrWordGuard(src, out);
  if (!verdict.ok) {
    return { id, text: src, edits: [], rejected: [{ before: out, why: `per-word guard: ${verdict.why}` }] };
  }

  // Express the accepted correction as contract-legal edits. A pair too far
  // apart to derive is a rewrite the guard's word-local view could not see.
  const derived = deriveEdits(src, out);
  if (!derived) {
    return {
      id, text: src, edits: [],
      rejected: [{ before: out, why: 'edit derivation refused: output too far from the source line' }],
    };
  }

  // Round-trip through the applier — the artifact must never claim an edit
  // list that does not reproduce its own text.
  const applied = applyEdits(src, derived.edits);
  if (!applied.ok || applied.text !== out) {
    return {
      id, text: src, edits: [],
      rejected: [{ before: out, why: 'applier round-trip failed to reproduce the model output' }],
    };
  }

  return { id, text: out, edits: derived.edits, rejected: [] };
}

async function runOcr(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to read and write'));
  loadRun(runDir);

  await withStageRecord(runDir, 'ocr', async () => {
    const lines = readScanLines(runDir).lines;
    const work = lines.filter((l) => l.text.trim().length > 0);
    log(`ocr: ${work.length} non-empty lines of ${lines.length} to repair`);

    const plan = resolveStageModels(args, 'ocr');
    log(`ocr: ${describePlan(plan)}`);

    const server = buildServer(args, 'ocr', plan);
    const results: OcrLine[] = [];
    try {
      let done = 0;
      for (const line of lines) {
        if (line.text.trim().length === 0) {
          results.push({ id: line.id, text: line.text, edits: [], rejected: [] });
          continue;
        }
        const raw = await server.complete({
          prompt: toOcrRawPrompt(line.text),
          adapter: plan.adapterPath ? 'ocr' : null,
          stop: [OCR_STOP],
          // eval-line.py's budget, exactly: the answer is the line again, so
          // its own length plus headroom bounds the generation.
          nPredict: line.text.length + 64,
        });
        results.push(repairLine(line.id, line.text, extractOcrAnswer(raw)));
        done++;
        if (done % 100 === 0) log(`  ocr: ${done}/${work.length} lines`);
      }
    } finally {
      await server.stop();
    }

    writeArtifact(runDir, 'ocrLines', { lines: results });
    recordModel(runDir, 'ocr', plan);

    const touched = results.filter((l) => l.edits.length > 0).length;
    const refused = results.reduce((n, l) => n + l.rejected.length, 0);
    log(
      `ocr: wrote ${ARTIFACTS.ocrLines.path} — ${touched} lines corrected, `
      + `${refused} outputs refused by the guards, ${lines.length - touched} unchanged`,
    );
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// footnotes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Categories whose text is never asked about.
 *
 * A running head is not prose and has no footnote markers in it; asking anyway
 * spends a round-trip per page and gives the model a chance to fire on clean
 * furniture, which is the failure that damages a book (ARCHITECTURE §7).
 */
const NON_PROSE: ReadonlySet<string> = new Set([
  'header', 'footer', 'image', 'caption', 'table', 'list', 'discard',
]);

/**
 * The text of a block, rebuilt from the lines it was formed out of.
 *
 * `blocks/blocks.json` carries line IDS and no text, deliberately: the words live
 * in `scan/lines.json`, and a block holding its own copy would be a second
 * source of truth for what the book says. So every consumer joins.
 */
/**
 * The text the footnotes stage must judge is the text the book will SHIP —
 * the ocr-corrected lines, when that stage has run. Deriving deletions against
 * the raw scan and then replacing the block wholesale at export was the first
 * bug the 2-page end-to-end run caught: every block dagger touched shipped its
 * RAW text minus markers, silently discarding its OCR corrections ("Miiller"
 * back in the EPUB while ocr/lines.json held "Müller").
 *
 * Coverage is all-or-nothing for the same reason as the exporter's check: a
 * partially-populated overlay would mix corrected and uncorrected text with no
 * way to tell which is which.
 */
function correctedScanLines(runDir: string): ScanLine[] {
  const lines = readScanLines(runDir).lines;
  if (!hasArtifact(runDir, 'ocrLines')) return [...lines];
  const corrected = new Map(readOcrLines(runDir).lines.map((l) => [l.id, l.text]));
  const missing = lines.filter((l) => !corrected.has(l.id));
  if (missing.length > 0) {
    throw new Error(
      `ocr/lines.json is present but does not cover ${missing.length} scan line(s) `
      + `(first: ${missing.slice(0, 5).map((l) => l.id).join(', ')}). `
      + `Re-run the ocr stage over the whole book.`,
    );
  }
  return lines.map((l) => ({ ...l, text: corrected.get(l.id)! }));
}

function blockTexts(blocks: readonly Block[], lines: readonly ScanLine[]): Map<string, string> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out = new Map<string, string>();
  for (const block of blocks) {
    const texts = block.lineIds.map((id) => {
      const line = byId.get(id);
      if (!line) {
        throw new Error(
          `block ${block.id} references line ${id}, which is not in ${ARTIFACTS.scanLines.path}. `
          + `The two artifacts are out of step — re-run scan and blocks together.`,
        );
      }
      return line.text;
    });
    out.set(block.id, texts.join('\n'));
  }
  return out;
}

async function runFootnotes(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to read and write'));
  loadRun(runDir);

  await withStageRecord(runDir, 'footnotes', async () => {
    const blocks = readBlocks(runDir).blocks;
    const texts = blockTexts(blocks, correctedScanLines(runDir));
    const candidates = blocks.filter(
      (b) => !NON_PROSE.has(b.category) && (texts.get(b.id) ?? '').trim().length > 0,
    );
    log(`footnotes: ${candidates.length} prose blocks of ${blocks.length}`);

    const plan = resolveStageModels(args, 'footnotes');
    log(`footnotes: ${describePlan(plan)}`);

    const server = buildServer(args, 'footnotes', plan);
    const results: FootnoteBlockDeletions[] = [];
    try {
      // planFootnotes owns the prompt (FOOTNOTES_SYSTEM_PROMPT through
      // toRawPrompt) and the batching; this generator is only the wire. It sends
      // each prompt unchanged and returns one answer per prompt, in order — a
      // short array is a broken generator and it throws rather than being padded.
      const plan_ = await planFootnotes(
        candidates.map((b) => texts.get(b.id)!),
        async (prompts) => {
          const answers: string[] = [];
          for (const prompt of prompts) {
            answers.push(await server.complete({
              prompt,
              adapter: plan.adapterPath ? 'footnotes' : null,
              stop: [FOOTNOTES_STOP],
            }));
          }
          return answers;
        },
        { onProgress: (done, total) => log(`  footnotes: ${done}/${total} units`) },
      );

      for (const block of candidates) {
        const source = texts.get(block.id)!;
        const deletions = plan_.get(source);
        if (!deletions || deletions.length === 0) continue;
        // Applied ONE AT A TIME so the artifact can record which deletions
        // actually landed rather than just how many. Identical to the bulk call:
        // the applier edits the first remaining occurrence in document order, so
        // chaining single edits in that order is the same walk.
        let text = source;
        const applied: FootnoteDeletion[] = [];
        let rejected = 0;
        for (const deletion of deletions) {
          const result = applyFootnoteDeletions(text, [deletion]);
          if (result.rejected) { rejected += result.rejected; continue; }
          text = result.text;
          applied.push(deletion);
        }
        if (applied.length === 0 && rejected === 0) continue;
        results.push({ blockId: block.id, applied, rejected, text });
      }
    } finally {
      await server.stop();
    }

    writeArtifact(runDir, 'footnoteDeletions', { blocks: results });
    recordModel(runDir, 'footnotes', plan);

    const removed = results.reduce((n, r) => n + r.applied.length, 0);
    const refused = results.reduce((n, r) => n + r.rejected, 0);
    log(
      `footnotes: wrote ${ARTIFACTS.footnoteDeletions.path} — ${removed} markers removed, `
      + `${refused} edits refused by the guards`,
    );
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// export
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Read `--exclude-ids`: one block id per line, `#` comments allowed.
 *
 * The ids are NOT validated here. `src/export/exclude.ts` owns that check and
 * throws naming the ids that are not in the run — and it also owns which
 * spellings of a category are accepted. A second copy of either rule in the CLI
 * is how the two drift into disagreeing about what a valid exclusion is.
 */
function readExcludeIds(file: string | undefined): string[] {
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`--exclude-ids: no such file: ${file}`);
  }
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * Read `--overrides`: `{ "blocks": [{ "id", "text?", "category?" }] }`.
 *
 * SHAPE is checked here, because a malformed file is a fact about the file and
 * this is the only place that has read it. MEANING is not: whether an id exists
 * and whether a category is legal belong to the export stage, which owns the
 * blocks and the taxonomy — the same division `--exclude-ids` already follows.
 *
 * The check is strict about types rather than about extra keys. A caller
 * serializing `text: null` to mean "no change" would otherwise get a chapter
 * heading replaced by the word "null" in a shipped book.
 */
function readOverrides(file: string | undefined): OverrideRequest | undefined {
  if (!file) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`--overrides: no such file: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--overrides: ${file} is not valid JSON: ${(e as Error).message}`);
  }

  const shape = `expected { "blocks": [{ "id": string, "text"?: string, "category"?: string }] }`;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--overrides: ${file} is not an object — ${shape}`);
  }
  const blocksValue = (parsed as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocksValue)) {
    throw new Error(`--overrides: ${file} has no "blocks" array — ${shape}`);
  }

  const blocks: BlockOverride[] = blocksValue.map((entry, i) => {
    const where = `--overrides: ${file}, blocks[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} is not an object — ${shape}`);
    }
    const { id, text, category } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${where} has no "id" string — every override names the block it changes`);
    }
    if (text !== undefined && typeof text !== 'string') {
      throw new Error(`${where} ("${id}") has a "text" that is not a string`);
    }
    if (category !== undefined && typeof category !== 'string') {
      throw new Error(`${where} ("${id}") has a "category" that is not a string`);
    }
    return {
      id,
      ...(text === undefined ? {} : { text }),
      ...(category === undefined ? {} : { category }),
    };
  });

  return { blocks };
}

async function runExport(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to export from'));
  const output = optionalString(args, 'output');
  const categories = stringList(args, 'exclude');
  const blockIds = readExcludeIds(optionalString(args, 'exclude-ids'));
  const overrides = readOverrides(optionalString(args, 'overrides'));
  loadRun(runDir);

  await withStageRecord(runDir, 'export', async () => {
    const result = runExportStage({
      runDir,
      exclude: { categories, blockIds },
      ...(overrides ? { overrides } : {}),
      ...(output ? { outputPath: path.resolve(output) } : {}),
      log,
    });

    const { exclusions } = result;
    if (result.overrides.text > 0 || result.overrides.category > 0) {
      log(
        `export: applied ${result.overrides.text} text override(s) and `
        + `${result.overrides.category} category override(s)`,
      );
    }
    log(
      `export: ${exclusions.keptBlocks} of ${exclusions.totalBlocks} blocks kept — `
      + `${result.sections.length} sections, ${result.healedHyphens} hyphens healed, `
      + `${result.keptHyphens} kept unproven`,
    );
    log(`export: wrote ${result.epubPath}`);
    if (result.outputPath !== result.epubPath) log(`export: copied to ${result.outputPath}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// convert
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every stage in order, on one run directory.
 *
 * Nothing is swallowed: the first stage that cannot run throws, the process
 * exits nonzero, and every artifact written before it stays on disk. That is
 * what makes this resumable — re-running `convert` re-does the stages, and the
 * individual commands can be run one at a time against the same directory.
 */
async function runConvert(args: ParsedArgs): Promise<void> {
  await runScan(args);
  await runBlocks(args);
  await runOcr(args);
  await runFootnotes(args);
  await runExport(args);
}

// ═════════════════════════════════════════════════════════════════════════════
// models
// ═════════════════════════════════════════════════════════════════════════════

const MODEL_ROLES: readonly ('base' | FoundryAdapter)[] = ['base', 'blocks', 'ocr', 'footnotes'];

async function runModels(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action !== 'list' && action !== 'pull') {
    throw new UsageError(`models takes \`list\` or \`pull\`, got ${action ? `"${action}"` : 'nothing'}`);
  }
  const dir = optionalString(args, 'models-dir');
  if (action === 'list') return listModels(dir, flag(args, 'verify'));
  return pullModels(dir);
}

async function listModels(dir: string | undefined, verify: boolean): Promise<void> {
  const where = modelsDir(dir);
  const out: string[] = [`models directory: ${where}`, ''];

  if (FOUNDRY_MODELS.length === 0) {
    // Not "no models installed" — nothing has been PUBLISHED. Saying the wrong
    // one of those sends someone looking on their own disk for a file that does
    // not exist anywhere yet.
    out.push(
      'The catalog is empty: no foundry weights are published yet.',
      '',
      'The base model has not been cast and the three adapters are gated on their',
      'training runs. There is nothing to download, and `foundry models pull` will',
      'say the same thing. Entries land in src/models/catalog.ts only once the',
      'weights are live at their URLs and their sha256 has been verified.',
      '',
      'A local GGUF can be pointed at directly: --base-model <file> --adapter <file>.',
    );
    process.stdout.write(`${out.join('\n')}\n`);
    return;
  }

  for (const role of MODEL_ROLES) {
    const entries = FOUNDRY_MODELS.filter((m) =>
      role === 'base' ? m.kind === 'base' : m.adapter === role,
    ).sort((a, b) => b.rank - a.rank);
    out.push(`${role}:`);
    if (entries.length === 0) out.push('  (none catalogued)');
    for (const def of entries) {
      out.push(`  ${def.id}  ${await describeModel(def, dir, verify)}`);
      out.push(`    ${def.note}`);
    }
    out.push('');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function describeModel(
  def: FoundryModelDef,
  dir: string | undefined,
  verify: boolean,
): Promise<string> {
  const file = modelFilePath(def.id, dir);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return `missing (${mib(def.bytes)})`;
  }
  if (size !== def.bytes) return `WRONG SIZE: ${mib(size)} on disk, catalogued ${mib(def.bytes)}`;
  if (!verify) return `present (${mib(def.bytes)}, sha256 unchecked — pass --verify)`;
  const actual = await sha256File(file);
  return actual === def.sha256 ? `present, verified (${mib(def.bytes)})` : 'CHECKSUM MISMATCH';
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function pullModels(dir: string | undefined): Promise<void> {
  // requireDefaultModel is the gate, and with an empty catalog it throws the
  // not-published message. That is the correct failure: there is no substitute
  // to fetch and no partial success to report.
  const wanted = MODEL_ROLES.map((role) => ({ role, def: requireDefaultModel(role) }));
  const target = ensureModelsDir(dir);

  for (const { role, def } of wanted) {
    const file = path.join(target, def.filename);
    if (fs.existsSync(file) && fs.statSync(file).size === def.bytes) {
      log(`${role}: ${def.id} already present`);
      continue;
    }
    log(`${role}: downloading ${def.id} (${mib(def.bytes)})`);
    let lastPct = -1;
    await downloadVerified({
      url: def.url,
      destPath: file,
      sha256: def.sha256,
      bytes: def.bytes,
      onProgress: (p) => {
        if (p.pct === lastPct || p.pct % 5 !== 0) return;
        lastPct = p.pct;
        log(`  ${def.id}: ${p.pct}%`);
      },
    });
    log(`${role}: ${def.id} verified and installed at ${file}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The command table
// ═════════════════════════════════════════════════════════════════════════════

export const COMMANDS: readonly Command[] = [
  {
    name: 'convert',
    summary: 'Full pipeline: page renders in, a clean EPUB out.',
    usage: '--pages <dir> --run <dir> -o <book.epub>',
    detail: [
      'Runs every stage in order against one run directory:',
      '',
      '  scan       the pinned Tesseract at 200 dpi segments each page into lines',
      '  blocks     the blocks adapter labels every block (body, chapter, header,',
      '             footnote, caption, discard, …)',
      '  ocr        the ocr adapter repairs Tesseract errors line by line, under',
      '             the edit contract — the model emits edits, an applier applies',
      '             them, and an edit that does not match the source is rejected',
      '  footnotes  the footnotes adapter strips inline reference markers so TTS',
      '             does not read them aloud',
      '  export     labels drive the XHTML: what is narrated, what is dropped,',
      '             and where the chapter splits go',
      '',
      'Every stage writes its artifact into the run directory and the next stage',
      'reads it from there (docs/PIPELINE.md). A stage that fails leaves every',
      'earlier artifact intact, so a convert can be re-run, or picked up one',
      'command at a time.',
      '',
      'INPUT IS PAGE RENDERS, NOT A PDF. Rasterization is not built yet: pass a',
      'directory of binary PGM pages rendered at 200 dpi. BookForge supplies them',
      'from its mupdf render pool.',
    ].join('\n'),
    options: [PAGES_DIR, RUN_DIR, OUTPUT_EPUB, EXCLUDE, EXCLUDE_IDS],
    run: runConvert,
  },
  {
    name: 'scan',
    summary: 'Segment page renders into lines with the pinned Tesseract.',
    usage: '--pages <dir> --run <dir>',
    detail: [
      'Reads every .pgm in --pages in natural page order, finds the text lines',
      'with the projection-profile band segmenter (deskewing the page first where',
      'it is tilted), and runs the PINNED Tesseract over one crop per line.',
      '',
      'Writes:',
      '  <run>/scan/pages.json   per page: size, deskew angle, columns, coverage',
      '  <run>/scan/lines.json   per line: id, page, box, text, mean confidence',
      '  <run>/run.json          input hash, tesseract version, stage state',
      '',
      'The dpi and the Tesseract version are not settings. Every model in this',
      'repo was trained on the output of one specific Tesseract at 200 dpi, and',
      'segmentation moves with both — a different build or a different resolution',
      'hands the models an input distribution they never saw, and the damage shows',
      'up as a bad model rather than a bad scan.',
      '',
      'Layout is taken away from Tesseract on purpose: its own analysis silently',
      'DROPS whole lines, and a dropped line is invisible to confidence scores.',
      'Bands find the lines; --psm 7 reads them; a band that reads as nothing is',
      'retried at --psm 13 and the rescue is counted.',
    ].join('\n'),
    options: [PAGES_DIR, RUN_DIR],
    run: runScan,
  },
  {
    name: 'blocks',
    summary: 'Label each block with what it is (adapter: foundry-blocks).',
    usage: '--run <dir>',
    detail: [
      'Groups the scanned lines into blocks, then runs the blocks adapter over',
      'every block on every page and writes a category onto each one: body, title,',
      'chapter, heading, subheading, quote, caption, footnote, header, footer,',
      'image, list, discard.',
      '',
      'The category is what makes an EPUB out of a scan. It decides what gets',
      'narrated, what is thrown away (running heads, page numbers, scanner',
      'artifacts), and where the chapter boundaries fall.',
      '',
      'Blocks are encoded a page at a time, because a running head is only',
      'recognizable as one relative to the rest of the page. The prompt is built',
      'by our own encoder and sent VERBATIM to llama-server /completion; the model',
      'id carries the version, and the version picks both the prompt format and',
      'the legal class list — with --adapter, the version is read from the GGUF',
      'FILENAME.',
      '',
      'Reads  <run>/scan/{pages,lines}.json',
      'Writes <run>/blocks/blocks.json',
      '',
      'NOTE: line→block grouping here is provisional (recorded as "gap-v0"). The',
      'training corpus used Tesseract\'s own paragraph identity, which the band',
      'path cannot produce; matching it is a prerequisite before predictions from',
      'this stage can be trusted.',
    ].join('\n'),
    options: [RUN_DIR],
    run: runBlocks,
  },
  {
    name: 'ocr',
    summary: 'Repair Tesseract OCR errors (adapter: foundry-ocr).',
    usage: '--run <dir>',
    detail: [
      'Runs the ocr adapter line by line over the recognized text and repairs what',
      'Tesseract got wrong: broken ligatures, rn/m, l/1/I, split and fused words,',
      'dropped diacritics.',
      '',
      'The model does not get to rewrite the book. Its answer is turned into',
      'EDITS — `before → after` pairs — and a deterministic applier applies them,',
      'rejecting any `before` it cannot find verbatim in the line. That contract',
      'is what keeps a small model from rewriting the author: a hallucinated edit',
      'fails to match and is dropped, instead of silently replacing a sentence.',
      '',
      'Hyphenation across a line break is a JOIN, never a completion: the two',
      'halves are rejoined as they appear, and the model is never asked to guess',
      'the rest of a word.',
      '',
      'NOT RUNNABLE IN THIS BUILD. The edit contract and applier are here',
      '(src/ocr/edits.ts); the trained-against system prompt has not been migrated',
      'from BookForgeApp and will not be re-typed. See docs/MIGRATION.md §2.',
    ].join('\n'),
    options: [RUN_DIR],
    run: runOcr,
  },
  {
    name: 'footnotes',
    summary: 'Strip inline footnote reference markers (adapter: foundry-footnotes).',
    usage: '--run <dir>',
    detail: [
      'Finds the footnote reference markers left inline in the body text — †, ‡,',
      '*, superscript numbers, and the OCR debris they turn into — and deletes',
      'them, so a narrator does not read "the treaty collapsed 47" out loud.',
      '',
      'The model emits `<anchor+marker> → <anchor>` lines, or the single word',
      '`none`. The applier enforces a SUBSEQUENCE GUARD: `after` must be reachable',
      'from `before` by deleting characters only. A model that tries to reword,',
      'resupply a missing letter, or fix punctuation on the way past is rejected',
      'by construction, not by review.',
      '',
      'Only prose blocks are asked about — headers, footers, captions, tables and',
      'images are skipped, because a model that fires on clean furniture damages a',
      'book and gains nothing.',
      '',
      'Reads  <run>/blocks/blocks.json',
      'Writes <run>/footnotes/deletions.json',
    ].join('\n'),
    options: [RUN_DIR],
    run: runFootnotes,
  },
  {
    name: 'export',
    summary: 'Build an EPUB from labelled, corrected blocks.',
    usage: '--run <dir> -o <book.epub> [--exclude <category>]...',
    detail: [
      'Turns labelled blocks into XHTML and packages an EPUB. The categories do',
      'the work: chapter blocks start a spine item and a TOC entry, title opens',
      'the title section, heading/subheading emit h2/h3 in place, body blocks flow',
      'into paragraphs, and footnotes are collected at the end of their chapter',
      'with no body linking.',
      '',
      'Exclusion is ONE filter at two granularities, and they compose: a block is',
      'dropped if its category is in --exclude OR its id is in --exclude-ids. The',
      'second is how BookForge exports after a user deletes individual boxes in',
      'pdf-picker.',
      '',
      '--overrides <file> carries the user\'s own edits into the book:',
      '',
      '    { "blocks": [ { "id": "b0007", "text": "The Lost Empire" },',
      '                  { "id": "b0031", "category": "caption" } ] }',
      '',
      'A "text" replaces that block\'s text entirely, as one line — this is how a',
      'chapter heading retyped in pdf-picker reaches the EPUB, whether it was',
      'split across three blocks by block formation or misread by the scan. A',
      '"category" relabels the block before grouping, so a block corrected to',
      'chapter opens a section and a TOC entry like any other. Every id must be in',
      'blocks/blocks.json; one that is not stops the export and is named.',
      '',
      'Re-export is cheap by construction: it reads the run directory and touches',
      'no upstream stage, so editing the exclusions and re-running costs no',
      're-scan and no re-inference. That is the pdf-picker interaction — delete',
      'boxes, rebuild the book.',
      '',
      'The EPUB is ALWAYS written to <run>/export/book.epub, which is the',
      'contract; -o additionally copies it somewhere convenient. A book with no',
      'detectable paragraph convention still exports, with few or no breaks, and',
      'says so loudly — that is the one sanctioned degradation in the pipeline.',
    ].join('\n'),
    options: [RUN_DIR, OUTPUT_EPUB, EXCLUDE, EXCLUDE_IDS, OVERRIDES],
    run: runExport,
  },
  {
    name: 'models',
    summary: 'Fetch and verify the base model and adapters.',
    usage: '<pull|list>',
    detail: [
      'foundry models list',
      '    Show the catalog: the base model and the three adapters, each with its',
      '    id, size, and whether it is present on disk. --verify also checks the',
      '    sha256 of what is there, which reads every byte.',
      '',
      'foundry models pull',
      '    Download whatever is missing from HuggingFace (owner: owenmorgan) into',
      '    the models directory, verifying sha256 on arrival. A file whose hash',
      '    does not match is deleted and named, never used.',
      '',
      'The catalog is EMPTY in this build: no foundry weights are published yet,',
      'and both commands say so. A local GGUF can still be used directly with',
      '--base-model <file> --adapter <file>.',
      '',
      'Weights live on HuggingFace; only code lives in git. Nothing is bundled',
      'into the binary — the distribution is three binaries plus the weights they',
      'pull on first run.',
    ].join('\n'),
    options: [{ name: 'verify', type: 'boolean', describe: 'Also check the sha256 of installed files.' }],
    positionals: [{ name: 'pull|list', describe: 'Which model action to run.' }],
    run: runModels,
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// Help + dispatch
// ═════════════════════════════════════════════════════════════════════════════

/** The global option block, for the top-level help. */
export function formatOptionsBlock(): string {
  return formatOptions(GLOBAL_OPTIONS);
}

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function commandHelp(cmd: Command): string {
  const opts = [...(cmd.options ?? []), ...GLOBAL_OPTIONS];
  const lines = [`foundry ${cmd.name} ${cmd.usage}`.trimEnd(), '', cmd.detail, ''];

  if (cmd.positionals?.length) {
    lines.push('Arguments:');
    const pad = Math.max(...cmd.positionals.map((p) => p.name.length));
    for (const p of cmd.positionals) lines.push(`  ${p.name.padEnd(pad)}  ${p.describe}`);
    lines.push('');
  }

  lines.push('Options:', formatOptions(opts));
  return lines.join('\n');
}

/**
 * Parse this command's arguments and run it.
 *
 * `--help` is handled before anything else so that a half-typed command can
 * always ask what it wants. Everything after that is the command's own problem,
 * and every failure it raises propagates: nothing here catches an error to keep
 * going (ARCHITECTURE §8).
 */
export async function runCommand(cmd: Command, argv: readonly string[]): Promise<void> {
  const specs = [...(cmd.options ?? []), ...GLOBAL_OPTIONS];
  const parsed = parseArgs(argv, specs);

  if (flag(parsed, 'help')) {
    process.stdout.write(`${commandHelp(cmd)}\n`);
    return;
  }

  const required = cmd.positionals?.length ?? 0;
  if (parsed.positional.length < required) {
    throw new UsageError(
      `${cmd.name} needs ${required} argument${required === 1 ? '' : 's'}: `
      + `${cmd.positionals!.map((p) => p.name).join(' ')}`,
    );
  }

  await cmd.run(parsed);
}

/** `foundry --version`: the build, and the tree it came from. */
export function versionLine(): string {
  return `foundry ${versionString()}`;
}
