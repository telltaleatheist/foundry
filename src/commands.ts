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
 *  - **A role with no catalogued weights stops that stage, not the run before
 *    it.** Every role is published today (`src/models/catalog.ts`), but the
 *    handling stays: a stage whose family is uncatalogued builds its real inputs
 *    and then stops at model resolution with the not-published message, and
 *    `models pull` skips it and fetches the rest. An explicit `--base-model` /
 *    `--adapter` path overrides the catalog for anyone holding a local GGUF —
 *    an override, not a fallback.
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
import { planDisplayRuns, type DisplayRunBlock } from './blocks/display-run-merge.js';
import { BLOCK_FORMATION } from './blocks/formation.js';
import { runEpubCorrection } from './epub/correct-stage.js';
import { runEpubFootnotes } from './epub/footnotes-stage.js';
import { applyFootnoteDeletions, planFootnotes, type FootnoteDeletion } from './footnotes/applier.js';
import { FOOTNOTES_STOP } from './footnotes/prompt.js';
import { CORRECTION_UNIT_MAX_CHARS } from './ocr/sentences.js';
import { repairLines } from './ocr/stage.js';
import {
  FOUNDRY_MODELS,
  defaultModelFor,
  requireDefaultModel,
  type FoundryModelDef,
  type FoundryStage,
} from './models/catalog.js';
import { downloadVerified, sha256File } from './models/download.js';
import { ensureModelsDir, modelFilePath, modelsDir } from './models/paths.js';
import {
  describeVendorTesseract,
  ensureVendorTesseract,
  installedVendorRoot,
} from './models/vendor-tesseract.js';
import { calibrate } from './paragraphs/calibration.js';
import { computeBlockGeometry } from './paragraphs/geometry.js';
import { planParagraphSplits, type ParagraphSplitReport } from './paragraphs/splitter.js';
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
  type CalibrationVerdict,
  type RunArtifact,
  type ScanLine,
  type ScanPage,
  type StageName,
  type StageState,
  type Segmenter,
} from './pipeline/artifacts.js';
import { DEFAULT_PALETTE, parsePalette, type Palette } from './pdf/annotations.js';
import { writeBlockLayer } from './pipeline/blocks-document.js';
import { runEmbeddedScanStage, runGetTextStage } from './pipeline/document-stage.js';
import { applyExclusions } from './export/exclude.js';
import { runExportStage, type BlockOverride, type OverrideRequest } from './pipeline/export-stage.js';
import { runPdfFootnotes } from './pipeline/footnotes-document.js';
import { runReflowStage } from './pipeline/reflow-stage.js';
import { applyDeskew, processPage, type Box } from './scan/bands.js';
import { readPgm } from './scan/pgm.js';
import { OCR_DPI, recognizeBands, resolveTesseract, type ResolvedTesseract } from './scan/tesseract.js';
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

/**
 * The document-mode input and output.
 *
 * `--pdf` is always READ and `--out` is always WRITTEN, in every stage that
 * takes them, and no stage takes one path for both. That is the whole shape of
 * the document pipeline: a stage is a document in and a document out, and the
 * caller — not foundry — decides what the files are called.
 */
const PDF_IN: OptionSpec = {
  name: 'pdf',
  type: 'string',
  placeholder: '<file.pdf>',
  describe: 'The PDF to read. Never written to.',
};

const OUT_PATH: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<path>',
  describe: 'Where this stage writes its document. Required; foundry never invents a name.',
};

const PALETTE: OptionSpec = {
  name: 'palette',
  type: 'string',
  placeholder: '<file.json>',
  describe: 'Category → "#RRGGBB" for the block annotations. The caller owns the colours.',
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

const COVER: OptionSpec = {
  name: 'cover',
  type: 'string',
  placeholder: '<image>',
  describe: 'A JPEG or PNG to embed as the cover. Checked by its bytes, not its extension.',
};

const EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'Edit an existing EPUB rather than a run directory. Never written to.',
};

const REPORT: OptionSpec = {
  name: 'report',
  type: 'string',
  placeholder: '<file.json>',
  describe: 'Where the review report goes: every deletion in context, every refusal. --epub only.',
};

const DRY_RUN: OptionSpec = {
  name: 'dry-run',
  type: 'boolean',
  describe: 'Write the report and no EPUB — the measuring pass. --epub only.',
};

const ASK_EVERYTHING: OptionSpec = {
  name: 'ask-everything',
  type: 'boolean',
  describe: 'Ask about note bodies and index entries too, which are skipped by default. --epub only.',
};

const UNIT_CHARS: OptionSpec = {
  name: 'unit-chars',
  type: 'string',
  placeholder: '<n>',
  describe: `Sentence packing cap for ocr-correct. Default ${CORRECTION_UNIT_MAX_CHARS}; a budget, not a tuning knob.`,
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
export interface WorkingBlock {
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

/**
 * Record which model answered for a stage. The version in the id is the point.
 *
 * `models.base` is written only when a base was actually ridden. A fused
 * checkpoint loads no base, and recording its own id there would both claim a
 * base that was never loaded and overwrite the one a sibling stage did load —
 * leaving `models.base` decided by stage order.
 */
function recordModel(runDir: string, stage: FoundryStage, plan: ModelPlan): void {
  const run = loadRun(runDir);
  run.models[stage] = plan.stageId;
  if (plan.baseId !== null) run.models.base = plan.baseId;
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

/** The pin, as run.json records it: which binary read the pages, and at what dpi. */
function tesseractSegmenter(tess: ResolvedTesseract): Segmenter {
  return {
    kind: 'tesseract',
    version: tess.version,
    binarySha256: sha256Of(tess.binary),
    tessdata: [tess.lang],
    dpi: OCR_DPI,
  };
}

/**
 * Two inputs, one stage — the same shape `footnotes` already has.
 *
 * `--pages` is a directory of renders and means Tesseract reads them.
 * `--pdf` is a document that already carries text and means nothing is
 * rasterized at all. They are alternatives, not a ladder: naming both is a
 * command that means two different things, and naming neither is a command with
 * no input.
 */
async function runScan(args: ParsedArgs): Promise<void> {
  const pdf = optionalString(args, 'pdf');
  const pages = optionalString(args, 'pages');

  if (pdf && pages) {
    throw new UsageError(
      '--pdf and --pages name two different scans: one reads a document\'s own text layer, the '
      + 'other runs Tesseract over page renders. Pass one.',
    );
  }
  if (!pdf && !pages) {
    throw new UsageError(
      'scan needs an input: --pages <dir> for page renders, or --pdf <file.pdf> for a document '
      + 'that already carries text.',
    );
  }
  if (pdf) {
    await runEmbeddedScan(args, pdf);
    return;
  }
  if (args.options['out'] !== undefined) {
    throw new UsageError(
      '--out belongs to `scan --pdf`, which casts the working document as it reads. A Tesseract '
      + 'scan writes only the run directory; `foundry get-text` casts the working document from it.',
    );
  }
  await runTesseractScan(args, path.resolve(pages!));
}

/**
 * The embedded-text route: read the document's own text layer, emit the same
 * scan artifacts a Tesseract scan emits, and cast the working document in the
 * same pass.
 *
 * One pass rather than two because there is nothing to decide between them: the
 * text is already in the document, so "read it" and "make this the working
 * document" are one act, and a separate get-text step would have nothing to
 * write.
 */
async function runEmbeddedScan(args: ParsedArgs, pdf: string): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to write into'));
  const out = path.resolve(requireString(args, 'out', 'where the working PDF is written'));
  fs.mkdirSync(runDir, { recursive: true });
  await runEmbeddedScanStage({ pdfPath: path.resolve(pdf), runDir, outPath: out, log });
}

async function runTesseractScan(args: ParsedArgs, pagesDir: string): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to write into'));

  const files = listPageImages(pagesDir);
  // No vendorDir: the resolver owns the search order (checkout, beside the
  // executable, data dir). Passing one here pinned a single root, which is how
  // the packaged binary managed to look beside the .exe and nowhere else.
  const tess = await resolveTesseract({ binaryPath: optionalString(args, 'tesseract') });
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
      segmenter: tesseractSegmenter(tess),
      models: {},
      stages: pendingStages(),
    };
  }
  run.segmenter = tesseractSegmenter(tess);
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
// get-text
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Cast the working document for a scanned book: the original plus the scan's
 * line geometry, out comes a PDF that carries its own text.
 *
 * It is not recorded as a run STAGE. The run directory's stages are the five
 * PIPELINE.md names and they describe a run; this writes a document, and which
 * stage a document has reached is a byte offset in that document
 * (docs/DOCUMENT_MODES.md), not a status in a JSON file beside it.
 */
async function runGetText(args: ParsedArgs): Promise<void> {
  const pdf = path.resolve(requireString(args, 'pdf', 'the original PDF the scan was made from'));
  const runDir = path.resolve(requireString(args, 'run', 'the run directory holding the scan'));
  const out = path.resolve(requireString(args, 'out', 'where the working PDF is written'));
  await runGetTextStage({ pdfPath: pdf, runDir, outPath: out, log });
}

// ═════════════════════════════════════════════════════════════════════════════
// Block formation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Group a page's lines into blocks — the FIRST of three rules.
 *
 * **This grouping is PROVISIONAL and it is not the grouping the blocks model was
 * trained against.** The training corpus used Tesseract's own paragraph identity
 * (the `blockNum:parNum` key, "split-only block formation" in the v4 notes),
 * which the band path cannot produce: it hands Tesseract one crop per line under
 * `--psm 7`, so there is no page-level layout pass to ask.
 *
 * That matters enough to name loudly rather than bury, because it is precisely
 * the failure ARCHITECTURE §5 is about — a different segmentation is a different
 * input distribution, and the damage reads as a bad model. Which rules ran is
 * recorded in `blocks/blocks.json` as `formation` (`blocks/formation.ts`), so a
 * prediction made under one can be identified later.
 *
 * The rule itself is deliberately dull: a new block starts when the vertical gap
 * to the previous line exceeds `GAP_FACTOR` of the page's median line height, or
 * when the line does not overlap the running block horizontally at all (a column
 * change). Reading order is the order the bands came in, which is the band
 * segmenter's column-major order.
 *
 * Two rules then run over the result, and each is a half of the formation rather
 * than a tidy-up — a prediction made under one set and a prediction made under
 * another saw different blocks:
 *
 *  - `planParagraphSplits` CUTS what this rule left fused. The gap is the only
 *    thing it can see, so on a book whose paragraphs are marked by an indent or
 *    by a short last line it cuts nowhere, and a whole page of prose arrives as
 *    one block with no junction inside it for anything downstream to decide
 *    (BLOCKS_TRAINING §13b, measured on Kershaw: 24 body blocks, ~53 paragraphs).
 *  - `mergeDisplayRuns` REJOINS the pieces of a heading both cut apart.
 */
const GAP_FACTOR = 0.8;

export function formBlocks(pages: readonly ScanPage[], lines: readonly ScanLine[]): WorkingBlock[] {
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

/**
 * Cut the formed blocks at their paragraph starts.
 *
 * The geometry is decided in `paragraphs/splitter.ts`; this applies the plan,
 * which is the same division of labour `mergeDisplayRuns` has with
 * `planDisplayRuns`. Nothing here re-reads a coordinate: it slices `lineIds` at
 * the planned indices and rebuilds each piece with `makeBlock`, so every field
 * on a split block is computed the one way a block's fields are ever computed.
 *
 * Indices are reassigned per page so ids stay dense and in reading order —
 * which means a split changes the ids of the blocks after it on the page. That
 * is the point of the segmentation marker: those ids are keys, and they mean
 * something different under a different formation.
 */
export function splitParagraphs(
  blocks: readonly WorkingBlock[],
  lines: readonly ScanLine[],
  calibration: CalibrationVerdict,
): { blocks: WorkingBlock[]; report: ParagraphSplitReport } {
  const { splits, report } = planParagraphSplits(blocks, lines, calibration);
  if (splits.length === 0) return { blocks: [...blocks], report };

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const cutsOf = new Map<string, number[]>();
  for (const s of splits) {
    const at = cutsOf.get(s.blockId);
    if (at) at.push(s.lineIndex); else cutsOf.set(s.blockId, [s.lineIndex]);
  }

  const out: WorkingBlock[] = [];
  const perPageIndex = new Map<number, number>();
  const nextIndex = (page: number): number => {
    const i = perPageIndex.get(page) ?? 0;
    perPageIndex.set(page, i + 1);
    return i;
  };

  for (const b of blocks) {
    const at = cutsOf.get(b.id);
    if (!at) {
      out.push({ ...b, id: blockId(b.page, nextIndex(b.page)) });
      continue;
    }
    const bounds = [0, ...[...at].sort((x, y) => x - y), b.lineIds.length];
    for (let i = 1; i < bounds.length; i++) {
      const slice = b.lineIds.slice(bounds[i - 1], bounds[i]).map((id) => {
        const line = lineById.get(id);
        if (!line) throw new Error(`block ${b.id} names line ${id}, which scan/lines.json does not have.`);
        return line;
      });
      out.push(makeBlock(b.page, nextIndex(b.page), slice));
    }
  }
  return { blocks: out, report };
}

/**
 * Rejoin the pieces of a display heading that `formBlocks` cut apart.
 *
 * The gap splitter is a local rule — it sees two lines and the space between
 * them — so a chapter opening arrives as three or four blocks: the tracked
 * `CHAPTER 1` kicker, the title over two lines, sometimes a subtitle. The model
 * is then asked to categorize pieces of a thing rather than the thing, and the
 * EPUB export gets three chapter markers where the page has one heading.
 *
 * `planDisplayRuns` decides which pieces belong together from geometry alone.
 * It runs HERE, before anything is classified, because at inference there are no
 * categories to consult and because the corpus this model is trained on is
 * merged by the same rule — see the file's header for the two-repo contract.
 *
 * The merged block is rebuilt by `makeBlock` from the union of its lines rather
 * than assembled by hand, so every field on it (text, median type size, mean
 * confidence) is computed the one way a block's fields are ever computed.
 * Indices are reassigned so ids stay dense and in reading order.
 */
export function mergeDisplayRuns(
  pages: readonly ScanPage[],
  blocks: readonly WorkingBlock[],
  lines: readonly ScanLine[],
): WorkingBlock[] {
  if (blocks.length === 0) return [];

  const pageById = new Map(pages.map((p) => [p.page, p]));
  const forRule: DisplayRunBlock[] = blocks.map((b) => {
    const page = pageById.get(b.page);
    if (!page) {
      throw new Error(
        `block ${b.id} is on page ${b.page}, which is not in scan/pages.json — the two `
        + 'artifacts are out of step. Re-run scan and blocks together.',
      );
    }
    return {
      id: b.id,
      page: b.page,
      x: b.bbox[0],
      y: b.bbox[1],
      width: b.bbox[2] - b.bbox[0],
      height: b.bbox[3] - b.bbox[1],
      fontSize: b.fontSizePx,
      lineCount: b.lineCount,
      pageWidth: page.widthPx,
      pageHeight: page.heightPx,
      text: b.text,
    };
  });

  const plan = planDisplayRuns(forRule);
  if (plan.runs.length === 0) return [...blocks];

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const linesOf = (b: WorkingBlock): ScanLine[] => b.lineIds.map((id) => {
    const line = lineById.get(id);
    if (!line) {
      throw new Error(`block ${b.id} names line ${id}, which scan/lines.json does not have.`);
    }
    return line;
  });

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const swallowed = new Set(plan.runs.flatMap((r) => r.slice(1)));
  const leadOf = new Map(plan.runs.map((r) => [r[0], r]));

  const merged: WorkingBlock[] = [];
  const perPageIndex = new Map<number, number>();
  for (const b of blocks) {
    if (swallowed.has(b.id)) continue;
    const index = perPageIndex.get(b.page) ?? 0;
    perPageIndex.set(b.page, index + 1);
    const run = leadOf.get(b.id);
    if (!run) {
      merged.push({ ...b, id: blockId(b.page, index) });
      continue;
    }
    const runLines = run.flatMap((id) => linesOf(byId.get(id)!));
    merged.push(makeBlock(b.page, index, runLines));
  }
  return merged;
}

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
  /** The weights llama-server loads with `-m`. */
  modelPath: string;
  /**
   * The id of the base being ridden, or null when `modelPath` is a full
   * checkpoint that already contains the tune.
   *
   * Null is what makes `run.json` honest: a full-checkpoint stage did not load
   * the base, so it must not write one into `models.base` — and it must not
   * overwrite the base a sibling stage genuinely did load.
   */
  baseId: string | null;
  /**
   * The LoRA adapter, or null for a FUSED model — a catalogued `kind: 'full'`
   * entry, or a merged fine-tune given as `--base-model` with no `--adapter`.
   *
   * Null is not "run without a model". It is the case where the weights in
   * `modelPath` already contain the tune. Requests then carry no adapter, and
   * the server loads none, so nothing is silently half-applied.
   */
  adapterPath: string | null;
  /** The id recorded for the stage in `run.json`. Its version is load-bearing. */
  stageId: string;
  /**
   * The catalog entry the stage weights came from, or null for an explicit
   * `--base-model`/`--adapter` override.
   *
   * Carried so a stage can read facts the catalog knows and a filename cannot —
   * today that is `promptVersion` for blocks. An override has no entry to ask,
   * and falls back to the filename rule, which is what the filename rule is for.
   */
  stageDef: FoundryModelDef | null;
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
 *      someone holding weights of their own.
 *   2. the catalog (`src/models/catalog.ts`) + the models directory.
 *
 * (2) throws the not-published message from `requireDefaultModel` when a role
 * has no entry, and a catalogued-but-absent file names `foundry models pull`.
 * Those are different problems with different remedies, and conflating them
 * sends people searching their own disk for something nobody has uploaded.
 *
 * **A `kind: 'full'` stage does not resolve the base at all.** Its checkpoint is
 * fused, so the base is not merely unused — it is not part of the answer, and
 * demanding an 8 GB download that will never be loaded would be a fabricated
 * requirement. That is what lets a chain mix the two: `blocks` loads its own
 * fused model, `ocr` and `footnotes` load the shared base with their adapters,
 * and each stage's server is built from its own plan (`buildServer`) so the two
 * shapes never have to agree.
 */
function resolveStageModels(args: ParsedArgs, stage: FoundryStage): ModelPlan {
  const dir = optionalString(args, 'models-dir');

  const explicitBase = optionalString(args, 'base-model');
  const explicitAdapter = optionalString(args, 'adapter');

  if (explicitAdapter) {
    // An adapter needs something to ride. The base is the catalogued one unless
    // the caller named theirs.
    const base = explicitBase
      ? { path: requireGgufFile(explicitBase, '--base-model'), id: path.basename(explicitBase) }
      : catalogued('base', dir);
    return {
      modelPath: base.path,
      baseId: base.id,
      adapterPath: requireGgufFile(explicitAdapter, '--adapter'),
      stageId: path.basename(explicitAdapter),
      stageDef: null,
    };
  }

  // An explicit base with no adapter is a merged fine-tune, and the prompt
  // version is then read out of its FILENAME — which is the same rule as always:
  // the version lives in the name of whatever weights answer the request
  // (ARCHITECTURE §3). It is not a base being ridden, so `baseId` is null.
  if (explicitBase) {
    const file = requireGgufFile(explicitBase, '--base-model');
    return {
      modelPath: file,
      baseId: null,
      adapterPath: null,
      stageId: path.basename(explicitBase),
      stageDef: null,
    };
  }

  const def = requireDefaultModel(stage);
  const stageFile = cataloguedFile(def, stage, dir);

  if (def.kind === 'full') {
    return {
      modelPath: stageFile,
      baseId: null,
      adapterPath: null,
      stageId: def.id,
      stageDef: def,
    };
  }

  const base = catalogued('base', dir);
  return {
    modelPath: base.path,
    baseId: base.id,
    adapterPath: stageFile,
    stageId: def.id,
    stageDef: def,
  };
}

function catalogued(role: 'base' | FoundryStage, dir: string | undefined): { path: string; id: string } {
  const def = requireDefaultModel(role);
  return { path: cataloguedFile(def, role, dir), id: def.id };
}

function cataloguedFile(
  def: FoundryModelDef,
  role: 'base' | FoundryStage,
  dir: string | undefined,
): string {
  const file = modelFilePath(def.id, dir);
  if (!fs.existsSync(file)) {
    throw new Error(
      `The ${role} model ${def.id} is catalogued but not on disk at ${file}. `
      + `Run \`foundry models pull\`.`,
    );
  }
  return file;
}

/** What weights are about to answer, said plainly enough to catch a mistake. */
function describePlan(plan: ModelPlan): string {
  if (plan.adapterPath) return `adapter ${plan.stageId} on base ${plan.baseId}`;
  return `full model ${plan.stageId}, no adapter applied`;
}

/**
 * Which prompt format the blocks weights were trained on.
 *
 * The CATALOG is asked first, because it is the only thing that knows. The id's
 * version is foundry's release line, which restarted at v1, while the prompt
 * format carried on from BookForge — `foundry-blocks-v1-4b` is rubric v5. Read
 * out of the id, it would come back as 1 and encode the retired sixteen-class
 * taxonomy: legal-looking prompts, quietly worse answers.
 *
 * The filename rule remains the answer for `--base-model`/`--adapter`, where
 * there is no entry to ask and the name (`rubric-v5-4b-f16.gguf`) is the only
 * evidence there is.
 */
function blocksPromptVersion(plan: ModelPlan): BlocksVersion {
  const declared = plan.stageDef?.promptVersion;
  if (declared === undefined) return blocksVersionFor(plan.stageId);
  if (declared < 1 || declared > 6 || !Number.isInteger(declared)) {
    throw new Error(
      `The catalog declares promptVersion ${declared} for ${plan.stageId}, and `
      + `this build only knows blocks prompt formats 1-6. Upgrade foundry.`,
    );
  }
  return declared as BlocksVersion;
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
 * Whatever the plan says: a base with the stage's adapter, or a fused checkpoint
 * on its own with no adapter list — in which case `LlamaServer` emits `-m` and
 * no `--lora-scaled`, because there is no LoRA to scale.
 *
 * ONE SERVER PER STAGE, which is what lets the two shapes coexist in a chain.
 * A `convert` could hold one server carrying the adapters that share the base
 * (ARCHITECTURE §3), but `blocks` could never join it — an 8 GB fused model is
 * not an adapter and cannot be hot-swapped onto the base — so that optimisation
 * would cover ocr and footnotes only, and it is still not written.
 */
function buildServer(args: ParsedArgs, stage: FoundryStage, plan: ModelPlan): LlamaServer {
  const binaryPath = resolveLlamaServer(optionalString(args, 'llama-server'));
  const verbose = flag(args, 'verbose');
  return new LlamaServer({
    binaryPath,
    basePath: plan.modelPath,
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
 * Calibration runs FIRST, before anything is formed or classified. It is
 * label-free by design (it sees line geometry, not categories), the blocks
 * prompt is fed geometry expressed in the calibrated frame, and the paragraph
 * splitter needs the frame to measure an indent or a gap in the book's own
 * units. It is recomputed per stage rather than cached: it is one pass over line
 * boxes, and a cached verdict is one more thing that can be stale against the
 * lines.
 *
 * Then the three formation rules, in the order `formation` names them: the gap
 * cut, the paragraph-start splitter, the display-run rejoin. The splitter runs
 * BEFORE the rejoin on purpose — a cut it makes through a display heading is
 * exactly what the rejoin exists to undo, and putting it after would leave the
 * rejoin's input dependent on which of the two ran last.
 */
function readScanAndForm(runDir: string): {
  pages: ScanPage[];
  lines: ScanLine[];
  blocks: WorkingBlock[];
  calibration: CalibrationVerdict;
  split: ParagraphSplitReport;
} {
  const pages = readScanPages(runDir).pages;
  const lines = readScanLines(runDir).lines;
  const calibration = calibrate(lines.map((l) => ({ page: l.page, bbox: l.bbox })));
  const cut = splitParagraphs(formBlocks(pages, lines), lines, calibration);
  const blocks = mergeDisplayRuns(pages, cut.blocks, lines);
  const geometry = computeBlockGeometry(blocks, lines, calibration);
  for (const block of blocks) {
    const g = geometry.get(block.id);
    if (!g) throw new Error(`block ${block.id} got no geometry — computeBlockGeometry skipped it`);
    block.geometry = g;
  }
  return { pages, lines, blocks, calibration, split: cut.report };
}

async function runBlocks(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to read and write'));
  const pdf = optionalString(args, 'pdf');
  const workingPdf = pdf === undefined ? undefined : path.resolve(pdf);
  // Both files are read before the model is asked anything: a palette that does
  // not parse is a mistake worth meeting in the first second rather than after
  // an hour of inference.
  const palette = readPalette(optionalString(args, 'palette'));
  if (workingPdf !== undefined && !fs.existsSync(workingPdf)) {
    throw new Error(
      `--pdf: no such working PDF: ${workingPdf}.\n`
      + 'A working document is cast by `foundry get-text` (a scanned book) or by '
      + '`foundry scan --pdf` (a book that already has text).',
    );
  }
  if (workingPdf === undefined && args.options['palette'] !== undefined) {
    throw new UsageError(
      '--palette colours the block annotations, and annotations are only written with --pdf. '
      + 'Without it, blocks writes the run artifact and nothing has a colour.',
    );
  }
  loadRun(runDir);

  await withStageRecord(runDir, 'blocks', async () => {
    const { pages, lines, blocks, calibration, split } = readScanAndForm(runDir);
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
    // The splitter's own verdict, reported the same way and for the same
    // reason: a book whose paragraph starts were invisible produces blocks with
    // no junction inside them, and that has to be visible in the log rather than
    // inferred from a book that reads as one long paragraph.
    log(`blocks: ${split.message}`);

    // Model resolution happens HERE, after the run directory has been read and
    // the blocks formed, so an operator sees their run is sound before being
    // told the weights are missing — and so the prompt-format version, which is
    // read out of the model id, is known before anything is encoded.
    const plan = resolveStageModels(args, 'blocks');
    const version = blocksPromptVersion(plan);
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
      formation: BLOCK_FORMATION,
      calibration,
      blocks: blocks.map(toArtifactBlock),
    });
    recordModel(runDir, 'blocks', plan);
    log(`blocks: wrote ${ARTIFACTS.blocks.path} — ${blocks.length} labelled blocks`);

    // Document mode: the answer goes INTO the book. The run artifact above is
    // still written — BookForge reads it, and re-export from a run directory is
    // still a thing this build does — but a caller working in documents needs
    // nothing from it.
    if (workingPdf !== undefined) {
      await writeBlockLayer({
        pdfPath: workingPdf,
        blocks: blocks.map(b => ({
          id: b.id, page: b.page, bbox: b.bbox, lineIds: b.lineIds, category: b.category!,
        })),
        lines,
        pages,
        pitchPx: calibration.pitch,
        palette,
        log,
      });
    }
  });
}

/**
 * Read `--palette`: `{ "body": "#3b82f6", … }`.
 *
 * SHAPE and MEANING are both checked in `src/pdf/annotations.ts`, which owns the
 * taxonomy and the colour format; this reads the file and hands over what was
 * in it. The categories a caller does not name keep foundry's own colours,
 * which is not a fallback — a palette is a set of statements about individual
 * categories, and saying nothing about `caption` is not a request for it to be
 * invisible.
 */
function readPalette(file: string | undefined): Palette {
  if (!file) return DEFAULT_PALETTE;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`--palette: no such file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--palette: ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parsePalette(parsed, `--palette: ${file}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// ocr
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The ocr stage over a run directory.
 *
 * The repair itself lives in `src/ocr/stage.ts` — model → per-word guard → edit
 * derivation → applier round-trip — because `reflow` runs the SAME code against
 * a working document. Two implementations of "repair a line" is the same
 * failure as two copies of a prompt format, one directory down.
 *
 * `--exclude` and `--exclude-ids` build a KEEP-LIST: a block the export is
 * going to drop does not need a GPU pointed at its lines. Both mean here
 * exactly what they mean in `export` — `src/export/exclude.ts` owns the rule —
 * so a caller that already knows what it will drop says so once and pays for it
 * nowhere.
 */
async function runOcr(args: ParsedArgs): Promise<void> {
  const runDir = path.resolve(requireString(args, 'run', 'the run directory to read and write'));
  const categories = stringList(args, 'exclude');
  const blockIds = readExcludeIds(optionalString(args, 'exclude-ids'));
  loadRun(runDir);

  await withStageRecord(runDir, 'ocr', async () => {
    const lines = readScanLines(runDir).lines;
    const keep = keepList(runDir, { categories, blockIds });
    const asked = keep === undefined
      ? lines.filter(l => l.text.trim().length > 0).length
      : lines.filter(l => l.text.trim().length > 0 && keep.has(l.id)).length;
    log(`ocr: ${asked} lines of ${lines.length} to repair`);

    const plan = resolveStageModels(args, 'ocr');
    log(`ocr: ${describePlan(plan)}`);

    const server = buildServer(args, 'ocr', plan);
    let result;
    try {
      result = await repairLines({
        lines,
        ...(keep ? { keep } : {}),
        generate: (request) => server.complete({
          prompt: request.prompt,
          adapter: plan.adapterPath ? 'ocr' : null,
          stop: request.stop,
          nPredict: request.nPredict,
        }),
        onProgress: (done, total) => {
          if (done % 100 === 0) log(`  ocr: ${done}/${total} lines`);
        },
      });
    } finally {
      await server.stop();
    }

    writeArtifact(runDir, 'ocrLines', { lines: result.lines });
    recordModel(runDir, 'ocr', plan);
    log(
      `ocr: wrote ${ARTIFACTS.ocrLines.path} — ${result.corrected} lines corrected, `
      + `${result.refused} outputs refused by the guards, ${result.skipped} not asked about`,
    );
  });
}

/**
 * Which lines are worth the model, or undefined for "all of them".
 *
 * Undefined rather than a set holding everything, because the two are different
 * statements: no exclusions is the stage's normal shape and needs no
 * `blocks/blocks.json`, while an exclusion is a statement ABOUT BLOCKS and
 * cannot be honoured before there are any. Asking for one without the other is
 * a stop, not a silent full run.
 */
function keepList(
  runDir: string, exclude: { categories: string[]; blockIds: string[] },
): Set<string> | undefined {
  if (exclude.categories.length === 0 && exclude.blockIds.length === 0) return undefined;
  if (!hasArtifact(runDir, 'blocks')) {
    throw new Error(
      `--exclude and --exclude-ids name blocks, and ${ARTIFACTS.blocks.path} has not been written `
      + 'yet. Run `foundry blocks` first, or drop the exclusions and repair every line.',
    );
  }
  const { kept } = applyExclusions(readBlocks(runDir).blocks, exclude);
  return new Set(kept.flatMap(b => b.lineIds));
}

// ═════════════════════════════════════════════════════════════════════════════
// ocr-correct
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Correct the words of a finished book.
 *
 * `--epub` is the only input, and that is a decision rather than a milestone:
 * the planned PDF text-layer correction mode is DROPPED, because the working
 * PDF's text is never edited (rewriting a publisher's content streams from a
 * parse of them would re-lay-out the book). The scan path keeps its per-line
 * correction inside `reflow` as an implementation detail; the correction a USER
 * asks for happens here, once, on a book, with a report.
 *
 * Everything about the model path is the `ocr` stage's — `resolveStageModels`,
 * the same server, `repairLines`, the prompt sent verbatim. The stage module
 * owns the sentence cut and the projection back onto markup; this function is
 * the wire and the report file, nothing else.
 */
async function runOcrCorrect(args: ParsedArgs): Promise<void> {
  // One input, and `--pdf` / `--run` are not among this command's options at
  // all, so parseArgs refuses them by name before this runs. That is the right
  // shape: they are not modes that are unbuilt, they are modes that were ruled
  // out — a working document's text layer is never edited, and the scan path
  // corrects its lines inside `foundry reflow` on the way to the book.
  const epubPath = requireString(args, 'epub', 'the book to correct');
  const resolved = path.resolve(epubPath);
  const dryRun = flag(args, 'dry-run');
  const output = optionalString(args, 'output');
  const reportPath = path.resolve(requireString(args, 'report', 'where the review report is written'));

  if (dryRun && output) {
    throw new UsageError('--dry-run writes no EPUB, so -o/--output would be a promise it does not keep');
  }
  if (!dryRun && !output) {
    throw new UsageError(
      'ocr-correct needs -o <book.epub> to write the corrected book, or --dry-run to write only '
      + 'the report',
    );
  }
  if (!fs.existsSync(resolved)) throw new Error(`--epub: no such file: ${resolved}`);

  const plan = resolveStageModels(args, 'ocr');
  log(`ocr-correct: ${describePlan(plan)}`);

  const server = buildServer(args, 'ocr', plan);
  let report;
  try {
    report = await runEpubCorrection({
      epubPath: resolved,
      outputPath: dryRun ? null : path.resolve(output!),
      model: describePlan(plan),
      maxChars: intOption(args, 'unit-chars', CORRECTION_UNIT_MAX_CHARS),
      log,
      // The same wire the `ocr` stage uses: the stage built the prompt and the
      // generation ceiling, and this sends them unchanged (ARCHITECTURE §4).
      generate: (request) => server.complete({
        prompt: request.prompt,
        adapter: plan.adapterPath ? 'ocr' : null,
        stop: request.stop,
        nPredict: request.nPredict,
      }),
    });
  } finally {
    await server.stop();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`ocr-correct: wrote ${reportPath}`);
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

/**
 * Two inputs, one stage.
 *
 * `--run` is the pipeline's own artifact directory; `--epub` is somebody else's
 * finished book. They are alternatives, not a ladder: naming both is a command
 * that means two different things at once, and naming neither is a command with
 * no input. Both are refused by name rather than resolved in some order.
 */
async function runFootnotes(args: ParsedArgs): Promise<void> {
  const epub = optionalString(args, 'epub');
  const runDir = optionalString(args, 'run');
  const pdf = optionalString(args, 'pdf');

  const named = [epub && '--epub', runDir && '--run', pdf && '--pdf'].filter(Boolean);
  if (named.length > 1) {
    throw new UsageError(
      `${named.join(' and ')} name different jobs: --epub edits an existing book, --run reads a `
      + 'scan foundry made, --pdf edits a working document. Pass one.',
    );
  }
  if (named.length === 0) {
    throw new UsageError(
      'footnotes needs an input: --pdf <working.pdf> for a working document, --run <dir> for a '
      + 'foundry run, or --epub <book.epub> for an existing book.',
    );
  }
  if (epub) {
    await runFootnotesEpub(args, epub);
    return;
  }
  if (pdf) {
    if (args.options['output'] !== undefined) {
      throw new UsageError(
        '--pdf edits the working document IN PLACE, as an incremental update, so there is nowhere '
        + 'for -o to write. The book comes out of `foundry reflow`.',
      );
    }
    if (args.options['ask-everything'] !== undefined) {
      throw new UsageError(
        '--ask-everything belongs to --epub mode. The three populations it turns off — navigation, '
        + 'note bodies, index entries — are found in a book\'s MARKUP; a working document\'s block '
        + 'categories already say which text is prose.',
      );
    }
    await runFootnotesPdf(args, path.resolve(pdf));
    return;
  }

  for (const name of ['report', 'output', 'dry-run', 'ask-everything'] as const) {
    if (args.options[name] !== undefined) {
      throw new UsageError(
        `--${name} belongs to --epub mode. A run writes ${ARTIFACTS.footnoteDeletions.path} `
        + `into the run directory, and \`foundry export\` builds the book from it.`,
      );
    }
  }
  await runFootnotesRun(args, path.resolve(runDir!));
}

/**
 * Document mode: the markers are in the text layer `get-text` wrote, and that
 * layer is rewritten in place.
 *
 * Same wire, same model resolution and same report discipline as `--epub`. The
 * report is required for the same reason: this stage deletes characters out of
 * somebody's book, and the number that decides whether it may be pointed at a
 * library is the false-fire rate, which is only readable from the report.
 */
async function runFootnotesPdf(args: ParsedArgs, pdfPath: string): Promise<void> {
  const reportPath = path.resolve(requireString(args, 'report', 'where the review report is written'));
  if (!fs.existsSync(pdfPath)) throw new Error(`--pdf: no such working PDF: ${pdfPath}`);

  const plan = resolveStageModels(args, 'footnotes');
  log(`footnotes: ${describePlan(plan)}`);

  const server = buildServer(args, 'footnotes', plan);
  let result;
  try {
    result = await runPdfFootnotes({
      pdfPath,
      dryRun: flag(args, 'dry-run'),
      model: describePlan(plan),
      log,
      generate: async (prompts) => {
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
    });
  } finally {
    await server.stop();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  log(`footnotes: wrote ${reportPath}`);
}

/**
 * EPUB mode: the markers are in publisher markup, not OCR debris.
 *
 * Everything about the model path is the run mode's — `resolveStageModels`, the
 * same server, `planFootnotes`, `FOOTNOTES_STOP`. The stage module owns the
 * walking and the projection back onto the markup; this function is the wire
 * and the report file, nothing else.
 */
async function runFootnotesEpub(args: ParsedArgs, epubPath: string): Promise<void> {
  const dryRun = flag(args, 'dry-run');
  const output = optionalString(args, 'output');
  const reportPath = path.resolve(requireString(args, 'report', 'where the review report is written'));

  if (dryRun && output) {
    throw new UsageError('--dry-run writes no EPUB, so -o/--output would be a promise it does not keep');
  }
  if (!dryRun && !output) {
    throw new UsageError(
      'footnotes --epub needs -o <book.epub> to write the edited book, or --dry-run to '
      + 'write only the report',
    );
  }
  if (!fs.existsSync(epubPath)) throw new Error(`--epub: no such file: ${epubPath}`);

  const plan = resolveStageModels(args, 'footnotes');
  log(`footnotes: ${describePlan(plan)}`);

  const server = buildServer(args, 'footnotes', plan);
  let report;
  try {
    report = await runEpubFootnotes({
      epubPath,
      outputPath: dryRun ? null : path.resolve(output!),
      model: describePlan(plan),
      askEverything: flag(args, 'ask-everything'),
      log,
      // The same wire as run mode: each prompt sent unchanged, one answer per
      // prompt, in order. A short array is a broken generator, and planFootnotes
      // throws on it rather than padding it out.
      generate: async (prompts) => {
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
    });
  } finally {
    await server.stop();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`footnotes: wrote ${reportPath}`);
}

async function runFootnotesRun(args: ParsedArgs, runDir: string): Promise<void> {
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
  const cover = optionalString(args, 'cover');
  const categories = stringList(args, 'exclude');
  const blockIds = readExcludeIds(optionalString(args, 'exclude-ids'));
  const overrides = readOverrides(optionalString(args, 'overrides'));
  loadRun(runDir);

  await withStageRecord(runDir, 'export', async () => {
    const result = runExportStage({
      runDir,
      exclude: { categories, blockIds },
      ...(overrides ? { overrides } : {}),
      ...(cover ? { coverPath: path.resolve(cover) } : {}),
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
      + `${result.keptHyphens} kept unproven, ${result.softJoinedHyphens} soft-hyphen joins, `
      + `${result.strippedSoftHyphens} stray soft hyphens removed`,
    );
    log(`export: wrote ${result.epubPath}`);
    if (result.outputPath !== result.epubPath) log(`export: copied to ${result.outputPath}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// reflow
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The working document in, the EPUB out — and nothing else on the command line
 * but where each of them lives.
 *
 * The ocr adapter is passed as a FACTORY, so a book that turns out to carry its
 * own text never resolves the weights, never downloads eight gigabytes it will
 * not use, and never starts a server. The stage asks only when the document has
 * told it it is a scan.
 */
async function runReflow(args: ParsedArgs): Promise<void> {
  const pdf = path.resolve(requireString(args, 'pdf', 'the working PDF to build the book from'));
  const out = path.resolve(requireString(args, 'out', 'where the EPUB is written'));
  const cover = optionalString(args, 'cover');

  let server: LlamaServer | null = null;
  try {
    const result = await runReflowStage({
      pdfPath: pdf,
      outPath: out,
      excludeCategories: stringList(args, 'exclude'),
      ...(cover ? { coverPath: path.resolve(cover) } : {}),
      ocr: async () => {
        const plan = resolveStageModels(args, 'ocr');
        log(`reflow: ${describePlan(plan)}`);
        server = buildServer(args, 'ocr', plan);
        const started = server;
        return (request) => started.complete({
          prompt: request.prompt,
          adapter: plan.adapterPath ? 'ocr' : null,
          stop: request.stop,
          nPredict: request.nPredict,
        });
      },
      log,
    });
    log(
      `reflow: ${result.keptBlocks} of ${result.totalBlocks} blocks, ${result.keptLines} lines, `
      + `class ${result.documentClass}`,
    );
  } finally {
    if (server !== null) await (server as LlamaServer).stop();
  }
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

const MODEL_ROLES: readonly ('base' | FoundryStage)[] = ['base', 'blocks', 'ocr', 'footnotes'];

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
    // not exist anywhere yet. Unreachable while the catalog carries entries; it
    // stays because the distinction is the thing worth keeping, not the state.
    out.push(
      'The catalog is empty: this build knows of no published foundry weights.',
      '',
      'There is nothing to download, and `foundry models pull` will say the same',
      'thing. Entries land in src/models/catalog.ts only once the weights are live',
      'at their URLs and their sha256 has been verified.',
      '',
      'A local GGUF can be pointed at directly: --base-model <file> --adapter <file>.',
    );
    process.stdout.write(`${out.join('\n')}\n`);
    return;
  }

  out.push(...(await describeVendorTesseract()), '');

  for (const role of MODEL_ROLES) {
    const entries = FOUNDRY_MODELS.filter((m) =>
      role === 'base' ? m.kind === 'base' : m.stage === role,
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
  /*
   * A role with nothing catalogued is SKIPPED, loudly, not fatal.
   *
   * This used to call requireDefaultModel for every role up front, so one
   * unpublished family aborted the whole command — and it aborted it before a
   * single byte was fetched, which meant a user whose blocks weights were not
   * yet published could not download the base, the ocr adapter or the footnotes
   * adapter either. "Pull whatever is missing" is what this command means, and
   * one absent family is not a reason to withhold the other three.
   *
   * The skip is reported per role, because silence here would read as "nothing
   * to do" on the one family that actually needs the user's attention.
   */
  const wanted: Array<{ role: 'base' | FoundryStage; def: FoundryModelDef }> = [];
  for (const role of MODEL_ROLES) {
    const def = defaultModelFor(role);
    if (def) {
      wanted.push({ role, def });
      continue;
    }
    log(`${role}: nothing catalogued in this build — skipped (no weights are published for it yet)`);
  }
  if (wanted.length === 0) {
    // Every role empty is a different statement from one role empty, and it is
    // the one requireDefaultModel words best: there is nothing to fetch at all.
    requireDefaultModel('base');
  }
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

  /*
   * The segmenter, last — after the weights rather than before them, because it
   * is the small download and finishing the 8 GB one first is the friendlier
   * order to be interrupted in.
   *
   * Not conditional on anything: a scan needs the pinned Tesseract exactly as
   * much as a label needs the blocks model, and leaving it to a separate
   * subcommand is how the packaged app ended up able to download every weight it
   * needed and still fail on page one.
   */
  const already = installedVendorRoot();
  if (already) {
    log(`tesseract: already present at ${already}`);
    return;
  }
  log('tesseract: downloading the pinned segmenter');
  let lastTessPct = -1;
  const root = await ensureVendorTesseract((p) => {
    if (p.pct === lastTessPct || p.pct % 5 !== 0) return;
    lastTessPct = p.pct;
    log(`  tesseract: ${p.pct}%`);
  });
  log(`tesseract: verified and installed at ${root}`);
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
    summary: 'Find the lines: pinned Tesseract over renders, or a PDF\'s own text.',
    usage: '--pages <dir> --run <dir>  |  --pdf <in.pdf> --run <dir> --out <working.pdf>',
    detail: [
      'EMBEDDED-TEXT MODE — `--pdf <in.pdf> --out <working.pdf>`:',
      '',
      'A book that already carries a text layer does not need Tesseract and must',
      'not get it: the words are the publisher\'s, set from the author\'s file, and',
      'recognizing a picture of them can only make them worse. So this mode reads',
      'the document\'s own text with its geometry and writes the SAME artifacts a',
      'Tesseract scan writes — one input shape for everything downstream.',
      '',
      'It casts the working document in the same pass, because there is nothing to',
      'decide between the two acts: the text is already in the PDF. The document',
      'records class `text`, which is how `reflow` knows to skip the ocr model.',
      '',
      'Geometry is projected into the SAME 200 dpi pixel frame a scan measures in,',
      'so the blocks model sees the numbers it was trained on rather than points.',
      'Lines carry no confidence: nothing recognized anything, and a fabricated',
      '100 would tell every consumer this text was measured when it was copied.',
      '',
      'A PDF with no extractable text stops the stage and says so — that book is a',
      'scan, and the route for a scan is --pages then `foundry get-text`.',
      '',
      'THE INPUT IS NEVER WRITTEN TO. --out may not be --pdf.',
      '',
      'TESSERACT MODE — `--pages <dir>`:',
      '',
      'Reads every .pgm in --pages in natural page order, finds the text lines',
      'with the projection-profile band segmenter (deskewing the page first where',
      'it is tilted), and runs the PINNED Tesseract over one crop per line.',
      '',
      'Writes (both modes):',
      '  <run>/scan/pages.json   per page: size, deskew angle, columns, coverage',
      '  <run>/scan/lines.json   per line: id, page, box, text, mean confidence',
      '  <run>/run.json          input hash, which segmenter read it, stage state',
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
    options: [PAGES_DIR, RUN_DIR, PDF_IN, OUT_PATH],
    run: runScan,
  },
  {
    name: 'get-text',
    summary: 'Write a scan\'s words into the PDF as an invisible text layer.',
    usage: '--pdf <original.pdf> --run <dir> --out <working.pdf>',
    detail: [
      'Casts the WORKING DOCUMENT for a scanned book. Takes the original PDF and',
      'the line geometry `foundry scan` measured, and writes one invisible text',
      'run per recognized line, positioned at that line\'s box — the OCRmyPDF',
      'technique. The result is a PDF whose pages are still the scan and whose',
      'text can be selected, copied and searched.',
      '',
      'This is the point where the pipeline becomes document-in / document-out.',
      'Every stage after it reads the DOCUMENT — `blocks` writes its categories in',
      'as annotations, `reflow` reads the text layer and the annotations and',
      'writes the EPUB — so nothing downstream has to be kept in step with a',
      'directory of JSON.',
      '',
      'It is the ONE full rewrite. Everything after it is a PDF incremental',
      'update: bytes appended, nothing moved, so every stage boundary is a byte',
      'offset and "reset to that stage" is a truncate. The rewrite also drops any',
      'linearization the original carried — a first-page layout declaration that',
      'an append silently invalidates (docs/PDF_SPIKE.md).',
      '',
      'The document records what it is: class `scanned`, which is how `reflow`',
      'knows these words came out of Tesseract and have to go through the ocr',
      'model before they are joined into paragraphs.',
      '',
      'Reads  <original.pdf>, <run>/scan/{pages,lines}.json',
      'Writes <working.pdf>',
      '',
      'THE ORIGINAL IS NEVER WRITTEN TO. --out may not be --pdf.',
      '',
      'The page count and every page\'s aspect ratio must match the scan. A scan',
      'of a different edition — or of the same book with its cover stripped —',
      'would put each page\'s words on some other page, and that is a book that is',
      'wrong everywhere with nothing visibly broken.',
    ].join('\n'),
    options: [PDF_IN, RUN_DIR, OUT_PATH],
    run: runGetText,
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
      'Lines are grouped into blocks by three rules in order: the vertical-gap',
      'cut, the paragraph-start splitter (indent / gap / short previous line,',
      'thresholds measured from the book itself), and the display-run rejoin.',
      'Which rules ran is recorded in blocks.json as "formation" — a prediction',
      'is only comparable to a corpus segmented the same way.',
      '',
      'NOTE: the grouping is still provisional. The training corpus used',
      'Tesseract\'s own paragraph identity, which the band path cannot produce;',
      'matching it is a prerequisite before predictions from this stage can be',
      'trusted.',
      '',
      'DOCUMENT MODE — `--pdf <working.pdf>`:',
      '',
      'The answer also goes INTO the book, as one square PDF annotation per',
      'block: coloured by category, named by its block id, carrying the block\'s',
      'text, and recording where it sits in the reading order. Open the working',
      'document in any annotation-aware reader and the layer is there — and a box',
      'moved or a heading retyped in that reader has edited the pipeline\'s state,',
      'with no side file to keep in step.',
      '',
      'Adjacent `chapter` blocks, and adjacent `title` blocks, are MERGED before',
      'they are written when they sit on the same page with nothing between them',
      'and no more than a paragraph\'s advance apart. Those two categories open a',
      'spine item, so a heading split across three lines otherwise becomes three',
      'chapters in the table of contents. The merge is recorded on the surviving',
      'annotation, so the blocks the model actually answered for stay identifiable.',
      '',
      'Detect REPLACES: every annotation foundry wrote is removed and the new set',
      'written, as ONE incremental update. Nothing else on the page is touched —',
      'a publisher\'s links and a reader\'s own highlights survive.',
      '',
      '--palette <file.json> takes `{ "body": "#3b82f6", … }`. The canonical',
      'palette belongs to whoever draws the boxes for a user; foundry accepts it',
      'as data and has its own only so that a box always has a colour.',
    ].join('\n'),
    options: [RUN_DIR, PDF_IN, PALETTE],
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
      '--exclude <category> and --exclude-ids <file> build a KEEP-LIST rather',
      'than filtering the output: every line still comes back, in order, but only',
      'the lines a block that survives those exclusions is built from are sent to',
      'the model. They mean exactly what they mean in `export`, so a caller that',
      'already knows it is dropping the notes apparatus pays no GPU time for it.',
      'Naming either before `foundry blocks` has run is a stop: an exclusion is a',
      'statement about blocks, and there are none yet.',
    ].join('\n'),
    options: [RUN_DIR, EXCLUDE, EXCLUDE_IDS],
    run: runOcr,
  },
  {
    name: 'ocr-correct',
    summary: 'Repair OCR errors in a finished EPUB (adapter: foundry-ocr).',
    usage: '--epub <in.epub> --report <file.json> [-o <out.epub> | --dry-run]',
    detail: [
      '    foundry ocr-correct --epub in.epub --report review.json --dry-run',
      '    foundry ocr-correct --epub in.epub --report review.json -o out.epub',
      '',
      'Runs the ocr adapter over the text of a book that is already a book, and',
      'writes the corrections back into its XHTML — the words change, the markup',
      'does not. A document no correction landed in is copied through with the',
      'exact bytes, method and CRC it came in with, so a diff between the input',
      'and the output is exactly the set of paragraphs that changed. THE INPUT IS',
      'NEVER WRITTEN TO.',
      '',
      'THIS IS THE ONLY CORRECTION THE PIPELINE OFFERS. There is no --pdf mode:',
      'a working document\'s text layer is the publisher\'s or the scan\'s, and it',
      'is never edited. Correction on the EPUB is where every other text',
      'transformation lives, and it is the only place a user can see what changed,',
      'undo it, and run it again.',
      '',
      'RUN IT FIRST among the EPUB passes. Footnote removal measures 97.0/0.5 on',
      'corrected text against 90.5/2.1 on raw, so correcting afterwards takes the',
      'worse number for nothing; and simplify and translate REWRITE the prose, so',
      'correcting after them edits the model\'s output rather than the book.',
      '',
      'THE UNIT IS A SENTENCE, packed to about 400 characters. More context',
      'disambiguates more errors, and the generation budget is derived from the',
      'input length so a longer unit costs proportionally. Units are cut only at',
      'sentence boundaries; a sentence longer than the cap is cut at a word',
      'boundary and never mid-word, because half a word is a fragment no amount of',
      'context repairs. A <br/> always ends a unit — the model answers with one',
      'line, so a prompt containing a line break could not round-trip.',
      '',
      'The model does not get to rewrite the book. Its answer goes through the',
      'same per-word guard and the same edit contract the `ocr` stage uses, and',
      'then through a PROJECTION that decides whether the accepted change can be',
      'written into the markup at all. Three refusals are the projection\'s own,',
      'and each is reported by name:',
      '',
      '  markup boundary  the anchor spans a tag — "the <em>main</em> point"',
      '                   cannot be rewritten without deciding what happens to',
      '                   the emphasis, so it is not.',
      '  entity           the anchor begins or ends inside "&amp;", which stands',
      '                   for one character in five bytes.',
      '  CDATA            escaping is opposite inside one, and this stage does',
      '                   not write into them.',
      '',
      'WHICH TEXT IS ASKED ABOUT: paragraphs, block quotes, headings, list items,',
      'definition lists, table cells, captions and bare divs — wider than the',
      'footnotes stage, because repairing a misread word cannot restructure a book',
      'the way deleting a digit can, and a misread chapter title is the one line a',
      'reader sees before deciding to read at all. A unit whose whole text sits',
      'inside one hyperlink is navigation, not prose, and is skipped.',
      '',
      'OFFERED ON EVERY BOOK, NEVER REFUSED. A book whose text is the publisher\'s',
      'has no OCR errors and every change would be the model editing an author —',
      'but provenance is not knowable from the file (an EPUB converted from a PDF',
      'before import looks the same), so the caveat is stated in the log and in',
      'the report rather than used to lock the door.',
      '',
      '--report is required and is the point of a dry run: per-document counts,',
      'every correction with ~80 characters of context either side, and every',
      'refused answer verbatim with its reason. That report is how the false-fire',
      'rate gets judged before this is pointed at a library.',
    ].join('\n'),
    options: [EPUB_IN, OUTPUT_EPUB, REPORT, DRY_RUN, UNIT_CHARS],
    run: runOcrCorrect,
  },
  {
    name: 'footnotes',
    summary: 'Strip inline footnote reference markers (adapter: foundry-footnotes).',
    usage: '--run <dir>  |  --pdf <working.pdf> --report <file.json> [--dry-run]  |  --epub <in.epub> --report <file.json> [-o <out.epub> | --dry-run]',
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
      '',
      'DOCUMENT MODE — `--pdf <working.pdf>`:',
      '',
      '    foundry footnotes --pdf working.pdf --report review.json --dry-run',
      '    foundry footnotes --pdf working.pdf --report review.json',
      '',
      'Runs over the text layer `foundry get-text` wrote and REWRITES that layer',
      'with the markers gone — one incremental update, the text streams replaced',
      'in place, every other object in the document untouched. There is no -o:',
      'the document is edited where it is, and the book comes out of `reflow`.',
      '',
      'Which blocks are prose comes from the block annotations, so `foundry',
      'blocks --pdf` has to have run. Headers, footers, captions, tables, lists,',
      'images and anything flagged deleted are never asked about — the same',
      'prose-only rule run mode has.',
      '',
      'A `text`-class working document is REFUSED. Its text layer is the',
      'publisher\'s — their fonts, their positioning, spread through the content',
      'streams of a book somebody typeset — and rewriting that from a parse of it',
      'would re-lay-out the book, which is a worse outcome than a marker left in.',
      'Export it and use --epub, where the markers are markup.',
      '',
      'EPUB MODE — `--epub <in.epub>`, for a book that is already a book:',
      '',
      '    foundry footnotes --epub in.epub --report review.json --dry-run',
      '    foundry footnotes --epub in.epub --report review.json -o out.epub',
      '',
      'The markers in a publisher\'s EPUB are markup, not OCR debris:',
      '<sup><a href="#fn3">3</a></sup>. So the text of every paragraph and block',
      'quote goes to the model in reading order, and the deletions are projected',
      'back onto the DOM text nodes they came from — a marker that spans a text',
      'node boundary, or that is the whole content of a <sup> or an <a>, is',
      'handled by that projection. An inline element a deletion empties is',
      'removed with it; an empty anchor left behind is a dead artifact.',
      '',
      'Documents nobody edited are copied through with the exact bytes, method',
      'and CRC they came in with, so the output differs from the input only',
      'where a marker was removed. THE INPUT IS NEVER WRITTEN TO.',
      '',
      'THREE POPULATIONS ARE NOT ASKED ABOUT, because each has the shape this',
      'model deletes — digits welded onto prose — without carrying a marker:',
      '',
      '  navigation  a unit whose whole text sits inside one hyperlink.',
      '              "3The Façade" is a table-of-contents line.',
      '  note body   a unit that OPENS with an intra-book back-link whose text',
      '              is a number: "1. Himmler and his companions were…". The',
      '              leading number is the note\'s own label, and deleting it',
      '              destroys the numbering of the notes section.',
      '  index entry a short phrase ending in page numbers — "Ahnenerbe',
      '              (Ancestral Heritage) 260, 266, 271, 275-9" — IN A DOCUMENT',
      '              that is mostly such units. The shape alone never skips',
      '              anything; a dateline has it too.',
      '',
      'Every skip is counted by reason, per document, in the report, and',
      '--ask-everything turns the note-body and index skips off. Headings, list',
      'items and table cells are not asked about either, matching run mode\'s',
      'prose-only rule.',
      '',
      '--report is required and is the point of a dry run: per-document counts,',
      'every applied deletion with ~80 characters of context either side, and',
      'every refused line verbatim with its reason. That report is how the',
      'false-fire rate gets judged before this is pointed at a library.',
    ].join('\n'),
    options: [RUN_DIR, PDF_IN, EPUB_IN, OUTPUT_EPUB, REPORT, DRY_RUN, ASK_EVERYTHING],
    run: runFootnotes,
  },
  {
    name: 'export',
    summary: 'Build an EPUB from labelled, corrected blocks.',
    usage: '--run <dir> -o <book.epub> [--cover <image>] [--exclude <category>]...',
    detail: [
      'Turns labelled blocks into XHTML and packages an EPUB. The categories do',
      'the work: chapter blocks start a spine item and a TOC entry, title opens',
      'the title section, heading/subheading emit h2/h3 in place, body blocks flow',
      'into paragraphs, and footnotes are collected at the end of their chapter',
      'with no body linking.',
      '',
      'A PAGE that is nothing but title blocks is a title page, and it becomes a',
      'spine item of its own ahead of the first chapter, the way a printed book',
      'has one. It is listed in the EPUB3 landmarks rather than in the reading',
      'contents, because a title page is not a chapter. Where a title block',
      'shares its page with anything else it is a display heading and opens an',
      'ordinary section, exactly as before.',
      '',
      '--cover <image> embeds a cover. It takes a JPEG or a PNG, and it decides',
      'which by reading the file\'s first bytes rather than its extension — a',
      '.jpg that some converter left as a PNG is the common case, and the media',
      'type declared in the package has to be what the file IS. Anything that is',
      'neither stops the export and is named; foundry does not re-encode images.',
      'The image is embedded verbatim as the cover, on a page of its own that is',
      'first in the spine and holds nothing but it. Order at the front of the',
      'book: cover, then the title page if there is one, then the chapters.',
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
    options: [RUN_DIR, OUTPUT_EPUB, COVER, EXCLUDE, EXCLUDE_IDS, OVERRIDES],
    run: runExport,
  },
  {
    name: 'reflow',
    summary: 'Working PDF in, EPUB out — the document is the only input.',
    usage: '--pdf <working.pdf> --out <book.epub> [--exclude <category>]... [--cover <image>]',
    detail: [
      'Reads the working document and writes the book. ONE file in, one file out:',
      'no run directory, no blocks.json, no exclusion list, no overrides file.',
      'Everything this stage needs is in the PDF, because every stage before it',
      'wrote its answer into the PDF.',
      '',
      '  the text layer   the words, with their geometry',
      '  the annotations  what each block is, where, what it says, whether it is',
      '                   deleted, and its place in the reading order',
      '  the catalog      the document class, the language, the frame\'s dpi, and',
      '                   the hash of the original this was cast from',
      '',
      'In one pass:',
      '',
      '  1. Drop what is not in the book — blocks flagged deleted, blocks on',
      '     pages flagged deleted, categories named by --exclude, and the page',
      '     furniture the exporter never emits. FIRST, so nothing after it is',
      '     spent on text nobody will read.',
      '  2. Repair the OCR, for a SCANNED document only, line by line through the',
      '     ocr adapter and its guards — and only over the lines that survived',
      '     step 1, so blocks a user deleted cost no GPU at all. A document that',
      '     arrived with its own text layer skips this: those words are the',
      '     publisher\'s, and a model editing them could only make them worse.',
      '     Which of the two it is, is recorded IN the document.',
      '  3. Reflow into paragraphs, with the book\'s own calibration and the',
      '     line-join rules. A wrap hyphen is healed only when the book itself',
      '     attests the joined word — never by guessing from the next letter.',
      '  4. Chapters from the `chapter` annotations. An annotation\'s text is the',
      '     definitive title, so a heading retyped in any PDF reader is the',
      '     chapter title, with no override file anywhere. Where nobody has',
      '     touched it, the repaired lines are used, because they are the same',
      '     words with the scan\'s errors taken out.',
      '',
      'DELETION IS IN THE DOCUMENT. A block annotation carrying /FoundryDeleted is',
      'dropped; so is every block on a page carrying /FoundryPageDeleted; so are',
      'the lines under a box somebody removed outright, because a line that no',
      'block contains is not in the book.',
      '',
      'THE WORKING DOCUMENT IS NEVER WRITTEN TO by this stage.',
    ].join('\n'),
    options: [PDF_IN, OUT_PATH, EXCLUDE, COVER],
    run: runReflow,
  },
  {
    name: 'models',
    summary: 'Fetch and verify the base model and the stage models.',
    usage: '<pull|list>',
    detail: [
      'foundry models list',
      '    Show the catalog: the base model and the three stage models, each with',
      '    its id, size, and whether it is present on disk. --verify also checks',
      '    the sha256 of what is there, which reads every byte.',
      '',
      'foundry models pull',
      '    Download whatever is missing from HuggingFace (owner: owenmorgan) into',
      '    the models directory, verifying sha256 on arrival. A file whose hash',
      '    does not match is deleted and named, never used.',
      '',
      'All four roles are published and catalogued in this build. A role that is',
      'not is reported and skipped rather than failing the pull, so one absent',
      'family never withholds the other three. A local GGUF can be used directly',
      'with --base-model <file> --adapter <file>.',
      '',
      'pull also fetches the pinned Tesseract for this platform when it is not',
      'already on disk — it is the segmenter the models were trained against, so',
      'it is as much a prerequisite as the weights (ARCHITECTURE §5).',
      '',
      'Weights live on HuggingFace and the Tesseract bundle on the GitHub release;',
      'only code lives in git. Nothing large is bundled into the binary — the',
      'distribution is the executables plus what they pull on first run.',
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
