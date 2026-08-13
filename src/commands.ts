/**
 * commands — the command surface, and what each command does.
 *
 * One command: `vlm-convert`. A document vision model reads each page of a PDF
 * and foundry assembles its answers into an EPUB. The Tesseract + stage-model
 * pipeline that used to live beside it was stripped out (git tag
 * `pre-vlm-strip` holds the whole thing); this route proved to be the better
 * answer to the same question, and carrying both meant every change had to be
 * reasoned about twice.
 *
 * Two rules this file is built around, both from docs/ARCHITECTURE.md:
 *
 *  - **No fallbacks (§8).** A missing interpreter, a missing package, a page
 *    that came back empty and an answer that does not parse are each an error
 *    that names the missing thing and exits nonzero. Nothing writes a
 *    plausible half-book and returns 0.
 *  - **The prompt is the model's interface and is sent verbatim (§4).** Every
 *    model in `src/vlm/models.ts` is asked the exact string its own model card
 *    documents; this file wires argv to the run and never reshapes a prompt.
 */
import * as path from 'node:path';

import {
  flag,
  formatOptions,
  optionalString,
  parseArgs,
  requireString,
  UsageError,
  type OptionSpec,
  type ParsedArgs,
} from './args.js';
import { buildReport, formatReport } from './backend/plan.js';
import { probeEndpoint, probeLocalPython, probeVllmLocal, probeWslVllm } from './backend/probe.js';
import { loadSettings, settingsPath, type FoundrySettings } from './backend/settings.js';
import { vlmConvert } from './vlm/convert.js';
import { DEFAULT_VLM_CONCURRENCY } from './vlm/endpoint.js';
import { DEFAULT_VLM_MODEL_ID, VLM_MODELS } from './vlm/models.js';
import { parsePageList } from './vlm/pages.js';
import { formatConflict, VLM_OUTPUT_FORMATS, type VlmOutputFormat } from './vlm/text-out.js';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_TRANSLATE_MODEL,
  translateEpub,
} from './translate/run.js';
import { versionString } from './version.js';

// ═════════════════════════════════════════════════════════════════════════════
// Options
// ═════════════════════════════════════════════════════════════════════════════

/** Flags every command accepts. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: 'help', short: 'h', type: 'boolean', describe: 'Show help for this command.' },
];

/**
 * The input and output.
 *
 * `--pdf` is always READ and `--out` is always WRITTEN, and no command takes
 * one path for both. The caller — not foundry — decides what the files are
 * called.
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
  describe: 'Where the book is written. Required; foundry never invents a name.',
};

/**
 * What `--out` is written AS, which is a different question from where.
 *
 * An extension that names the other format is refused rather than obeyed or
 * corrected — `text-out.ts` owns the rule and the sentence.
 */
const VLM_FORMAT: OptionSpec = {
  name: 'format',
  type: 'string',
  placeholder: '<epub|txt|pdf>',
  describe: 'What --out is written as. Default epub; txt is plain text; pdf is the scan, made searchable.',
};

const VLM_MODEL: OptionSpec = {
  name: 'vlm-model',
  type: 'string',
  placeholder: '<id>',
  describe: `Which document VLM reads the pages. Default ${DEFAULT_VLM_MODEL_ID}.`,
};

const VLM_PYTHON: OptionSpec = {
  name: 'python',
  type: 'string',
  placeholder: '<path>',
  describe: 'The interpreter with mlx-vlm and PyMuPDF in it. Also FOUNDRY_VLM_PYTHON.',
};

const VLM_RENDERS: OptionSpec = {
  name: 'renders',
  type: 'string',
  placeholder: '<dir>',
  describe: 'Keep the page images here. They are deleted as the run proceeds otherwise.',
};

const VLM_LANGUAGE: OptionSpec = {
  name: 'language',
  type: 'string',
  placeholder: '<bcp47>',
  describe: 'dc:language for the EPUB. Declared, not detected — nothing here reads a language.',
};

const VLM_ENDPOINT: OptionSpec = {
  name: 'vlm-endpoint',
  type: 'string',
  placeholder: '<url>',
  describe: 'An OpenAI-compatible server reads the pages instead of MLX, e.g. http://host:8000/v1.',
};

const VLM_ENDPOINT_MODEL: OptionSpec = {
  name: 'vlm-endpoint-model',
  type: 'string',
  placeholder: '<name>',
  describe: 'The name --vlm-endpoint\'s server was started with. Defaults to the registry entry\'s.',
};

const VLM_CONCURRENCY: OptionSpec = {
  name: 'vlm-concurrency',
  type: 'string',
  placeholder: '<n>',
  describe: `Pages in flight against --vlm-endpoint at once. Default ${DEFAULT_VLM_CONCURRENCY}, the measured knee.`,
};

const VLM_READINGS: OptionSpec = {
  name: 'readings',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'Bank each page\'s answer here as it lands, and re-read only what is missing.',
};

/**
 * The two ways to override what a completion marker decides, and they are
 * OPPOSITES. Passing both is refused in `runVlmConvert`.
 */
const VLM_FRESH_READINGS: OptionSpec = {
  name: 'fresh-readings',
  type: 'boolean',
  describe: 'Archive whatever --readings banks and read every page again, marker or no marker.',
};

const VLM_REUSE_READINGS: OptionSpec = {
  name: 'reuse-readings',
  type: 'boolean',
  describe: 'Rebuild the book from the banked answers even though a run already completed here.',
};

const VLM_SKIP_PAGES: OptionSpec = {
  name: 'skip-pages',
  type: 'string',
  placeholder: '<3,17,19-24>',
  describe: 'Pages that are not part of the book: never rendered, never read, never in the EPUB.',
};

const VLM_CHAPTERS: OptionSpec = {
  name: 'chapters',
  type: 'string',
  placeholder: '<file.json>',
  describe: 'Write the chapter PROPOSALS and the skipped pages here, for a person to confirm.',
};

const VLM_STRIP_MARKERS: OptionSpec = {
  name: 'strip-note-markers',
  type: 'boolean',
  describe: 'Remove footnote reference numbers from the prose. For a narration build.',
};

// ── translate ────────────────────────────────────────────────────────────────

const TR_EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'The foundry-converted EPUB to translate. Never written to.',
};

const TR_TO: OptionSpec = {
  name: 'to',
  type: 'string',
  placeholder: '<bcp47>',
  describe: 'The language to translate INTO, e.g. en, de, pt-BR. Required.',
};

const TR_FROM: OptionSpec = {
  name: 'from',
  type: 'string',
  placeholder: '<bcp47>',
  describe: 'The language of the book. Left out, the model is told to determine it.',
};

const TR_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<path>',
  describe: 'Where the translation is written. Default: the input with .<to> before .epub.',
};

const TR_MODEL: OptionSpec = {
  name: 'model',
  type: 'string',
  placeholder: '<name>',
  describe: `The Ollama model that translates. Default ${DEFAULT_TRANSLATE_MODEL}.`,
};

const TR_OLLAMA: OptionSpec = {
  name: 'ollama',
  type: 'string',
  placeholder: '<url>',
  describe: `The Ollama server. Default ${DEFAULT_OLLAMA_ENDPOINT}. Used, never started.`,
};

const TR_INSTRUCTIONS: OptionSpec = {
  name: 'instructions',
  type: 'string',
  placeholder: '<text>',
  describe: 'Appended to the system prompt verbatim — terminology rules for THIS book.',
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

/** Progress and diagnostics go to stderr; command RESULTS go to stdout. */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The endpoint probed when neither a flag nor a setting names one: vLLM's default. */
const DEFAULT_ENDPOINT_URL = 'http://localhost:8000/v1';

/**
 * A vlm-convert option that a setting may supply when its flag is absent.
 *
 * Flags always win, and an applied setting is LOGGED — a run that reads
 * through an endpoint nobody typed on this command line must say where the
 * URL came from, or the settings file becomes spooky action.
 */
function fromFlagOrSettings(
  args: ParsedArgs,
  flagName: string,
  settingValue: string | undefined,
  settingKey: string,
): string | undefined {
  const fromFlag = optionalString(args, flagName);
  if (fromFlag !== undefined) return fromFlag;
  if (settingValue !== undefined) {
    log(`vlm-convert: --${flagName} ${settingValue} (from ${settingKey} in ${settingsPath()})`);
    return settingValue;
  }
  return undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// vlm-convert
// ═════════════════════════════════════════════════════════════════════════════

async function runVlmConvert(args: ParsedArgs): Promise<void> {
  /*
   * The output, and what it is going to be.
   *
   * Read together and checked here because the pair can CONTRADICT: `--format
   * txt --out book.epub` is two instructions about one file that cannot both be
   * obeyed, and neither renaming the file nor ignoring the flag is a thing this
   * program does (ARCHITECTURE §8). `text-out.ts` decides and words it; this
   * layer only chooses the exit code, and 2 is right because nothing has run.
   */
  const outPath = requireString(args, 'out', 'where the book is written');
  const named = optionalString(args, 'format');
  if (named !== undefined && !VLM_OUTPUT_FORMATS.includes(named as VlmOutputFormat)) {
    throw new UsageError(
      `--format takes ${VLM_OUTPUT_FORMATS.join(' or ')}, not "${named}"`,
    );
  }
  const format = (named ?? 'epub') as VlmOutputFormat;
  const conflict = formatConflict(outPath, format);
  if (conflict !== null) throw new UsageError(conflict);

  const concurrency = optionalString(args, 'vlm-concurrency');
  if (concurrency !== undefined && !/^[1-9]\d*$/.test(concurrency)) {
    throw new UsageError(`--vlm-concurrency takes a positive whole number, not "${concurrency}"`);
  }
  const skipPages = optionalString(args, 'skip-pages');

  /*
   * The readings flags, checked here because this is the argv layer.
   *
   * Both are instructions about a bank, and both are REFUSED rather than
   * ignored when there is no bank to act on or when they contradict each other.
   * A flag that silently does nothing is how a person ends up believing they
   * ordered a fresh read and getting a cache replay.
   */
  const freshReadings = flag(args, 'fresh-readings');
  const reuseReadings = flag(args, 'reuse-readings');
  if (freshReadings && reuseReadings) {
    throw new UsageError(
      '--fresh-readings and --reuse-readings say opposite things about the same bank. Pass one.',
    );
  }
  if ((freshReadings || reuseReadings) && optionalString(args, 'readings') === undefined) {
    throw new UsageError(
      `--${freshReadings ? 'fresh-readings' : 'reuse-readings'} is about the bank --readings names, `
      + 'and no --readings was given.',
    );
  }

  /*
   * Settings fill in absent flags; they never override one (backend/settings).
   * The endpoint comes from settings only under mode "endpoint" — the mode is
   * the operator's statement that runs on this machine read through a server,
   * and honouring the URL under any other mode would make writing it down
   * enough to reroute every run.
   */
  const settings: FoundrySettings = loadSettings();
  const endpointFromSettings =
    settings.backend?.mode === 'endpoint' ? settings.backend.endpointUrl : undefined;
  const endpoint = fromFlagOrSettings(args, 'vlm-endpoint', endpointFromSettings, 'backend.endpointUrl');
  const endpointModel = endpoint === undefined
    ? optionalString(args, 'vlm-endpoint-model')
    : fromFlagOrSettings(args, 'vlm-endpoint-model', settings.backend?.endpointModel, 'backend.endpointModel');
  const python = fromFlagOrSettings(args, 'python', settings.backend?.python, 'backend.python');

  /*
   * Refused HERE, before a page renders: off macOS the only reading path is an
   * endpoint, and letting the run proceed without one ends in "no Python with
   * MLX was found" — a true sentence that points a Windows user at entirely
   * the wrong problem.
   */
  if (endpoint === undefined && process.platform !== 'darwin') {
    throw new Error(
      'no reading backend for this run: the local MLX path is Apple silicon only, and no endpoint '
      + 'was named. Pass --vlm-endpoint <url> (e.g. a vLLM server), or set backend.mode to '
      + `"endpoint" with backend.endpointUrl in ${settingsPath()}. `
      + '`foundry doctor` reports what this machine has.',
    );
  }

  const report = await vlmConvert({
    pdfPath: requireString(args, 'pdf', 'the PDF to read'),
    outPath,
    format,
    modelId: optionalString(args, 'vlm-model') ?? DEFAULT_VLM_MODEL_ID,
    ...(python !== undefined ? { python } : {}),
    ...(optionalString(args, 'renders') ? { rendersDir: optionalString(args, 'renders')! } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(endpointModel !== undefined ? { endpointModel } : {}),
    ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
    ...(optionalString(args, 'readings') ? { readingsPath: optionalString(args, 'readings')! } : {}),
    ...(freshReadings ? { freshReadings: true } : {}),
    ...(reuseReadings ? { reuseReadings: true } : {}),
    ...(skipPages !== undefined ? { skipPages: parsePageList(skipPages, '--skip-pages') } : {}),
    ...(optionalString(args, 'chapters') ? { chaptersPath: optionalString(args, 'chapters')! } : {}),
    stripNoteMarkers: flag(args, 'strip-note-markers'),
    language: optionalString(args, 'language') ?? 'en',
    log,
  });

  const { timings } = report;
  const perPage = timings.inferenceSeconds / report.inferredPages;
  // A run that read nothing has no rate, and printing one for it would be
  // printing a number about work that did not happen.
  const rate = report.inferredPages === 0
    ? 'every page came from the readings file'
    : `${report.inferredPages} read this run at ${perPage.toFixed(1)}s a page, `
      + `${(60 / perPage).toFixed(1)} pages a minute`;
  // The skipped pages are named on the completion line rather than only where
  // they were asked for: a run whose page count looks short is the moment
  // somebody wants to know whether that was a decision or a defect.
  const struck = report.skippedPages.length === 0
    ? ''
    : `, ${report.skippedPages.length} skipped (${report.skippedPages.join(', ')})`;
  // The peak is OMITTED where the platform cannot report it, rather than
  // printed as 0.0 GiB — a number that reads as a measurement and is not one.
  const peak = report.peakRssBytes === null
    ? ''
    : `, peak ${(report.peakRssBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  log(
    `vlm-convert: ${report.pages.length} pages in ${timings.totalSeconds.toFixed(1)}s (${rate})${struck}${peak}`,
  );
  const categories = Object.entries(report.categories).sort((a, b) => b[1] - a[1]);
  if (categories.length > 0) {
    log(`vlm-convert: ${categories.map(([name, n]) => `${name} ${n}`).join(', ')}`);
  }
  if (report.unreadable.length > 0) {
    // Last, and named again: the run has printed forty lines by now, and a page
    // that is not in the book has to be the thing still on screen at the end.
    log(
      `vlm-convert: ${report.unreadable.length} PAGE(S) ARE NOT IN THE BOOK — `
      + report.unreadable.map((p) => p.number).join(', '),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// translate
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `Book.epub` → `Book.en.epub`, and `Book` → `Book.en`.
 *
 * The tag goes BEFORE the extension so the file is still an `.epub` to every
 * reader and every file manager, and so the two editions of one book sort next
 * to each other in a directory listing.
 */
export function defaultTranslationOut(epubPath: string, to: string): string {
  const dot = epubPath.lastIndexOf('.');
  const slash = Math.max(epubPath.lastIndexOf('/'), epubPath.lastIndexOf('\\'));
  if (dot <= slash + 1) return `${epubPath}.${to}`;
  return `${epubPath.slice(0, dot)}.${to}${epubPath.slice(dot)}`;
}

async function runTranslate(args: ParsedArgs): Promise<void> {
  const epubPath = requireString(args, 'epub', 'the EPUB to translate');
  const to = requireString(args, 'to', 'the language to translate into');
  const outPath = optionalString(args, 'out') ?? defaultTranslationOut(epubPath, to);

  /*
   * Refused here, before a byte is read. `--out` equal to `--epub` is the one
   * mistake this command cannot recover from: the input is somebody's converted
   * book, the run takes hours, and an output written over it destroys the only
   * copy of the thing being translated — including the source text every
   * refusal message would have pointed at.
   */
  if (path.resolve(outPath) === path.resolve(epubPath)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the one and writes the other; a book `
      + 'overwritten by its own translation is the single input this command cannot get back.',
    );
  }

  const report = await translateEpub({
    epubPath,
    outPath,
    to,
    ...(optionalString(args, 'from') !== undefined ? { from: optionalString(args, 'from')! } : {}),
    ...(optionalString(args, 'model') !== undefined ? { model: optionalString(args, 'model')! } : {}),
    ...(optionalString(args, 'ollama') !== undefined ? { endpoint: optionalString(args, 'ollama')! } : {}),
    ...(optionalString(args, 'instructions') !== undefined
      ? { instructions: optionalString(args, 'instructions')! }
      : {}),
    log,
  });

  // The skipped blocks and the retries are on the completion line, not only in
  // the scroll above it: a book that came back with fourteen untranslated
  // tables in it has to say so at the moment somebody is looking at the result.
  const skipped = [...report.skipped].sort((a, b) => b[1] - a[1]);
  const struck = skipped.length === 0 ? '' : `, skipped ${skipped.map(([c, n]) => `${n} ${c}`).join(', ')}`;
  const asked = report.retries === 0 ? '' : `, ${report.retries} answers rejected and asked again`;
  log(
    `translate: ${report.blocks} blocks in ${report.seconds.toFixed(1)}s `
    + `(${(report.blocks / Math.max(report.seconds, 0.001)).toFixed(2)} a second, ${report.model})`
    + `${struck}${asked}`,
  );
  if (report.navUnmapped > 0) {
    log(
      `translate: ${report.navRelabelled} contents entries relabelled, ${report.navUnmapped} LEFT IN `
      + `THE SOURCE LANGUAGE — ${report.navUnmapped === 1 ? 'it is not a copy' : 'they are not copies'} `
      + 'of a heading this run translated',
    );
  }
  process.stdout.write(`${report.outPath}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// doctor
// ═════════════════════════════════════════════════════════════════════════════

async function runDoctor(args: ParsedArgs): Promise<void> {
  const settings = loadSettings();
  const endpointUrl =
    optionalString(args, 'endpoint') ?? settings.backend?.endpointUrl ?? DEFAULT_ENDPOINT_URL;

  /*
   * The four probes are independent measurements, so they run concurrently —
   * the WSL probe alone can take ten seconds when a distro has to boot, and
   * nothing about the endpoint answer depends on it.
   */
  const [endpoint, wslVllm, vllmLocal, mlx, rasteriser] = await Promise.all([
    probeEndpoint(endpointUrl),
    probeWslVllm(settings),
    probeVllmLocal(settings),
    probeLocalPython('mlx_vlm', settings),
    probeLocalPython('fitz', settings),
  ]);

  const report = buildReport({
    platform: process.platform,
    mode: settings.backend?.mode ?? 'auto',
    endpoint,
    wslVllm,
    vllmLocal,
    mlx,
    rasteriser,
  });

  // The report is the RESULT, so it goes to stdout — both shapes of it. The
  // app shells this command with --json and reads stdout; a person reads the
  // same facts formatted.
  if (flag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The command table
// ═════════════════════════════════════════════════════════════════════════════

export const COMMANDS: readonly Command[] = [
  {
    name: 'vlm-convert',
    summary: 'A vision model reads the pages: PDF in, EPUB, plain text or a searchable PDF out.',
    usage: '--pdf <file.pdf> --out <book.epub> [--format <epub|txt|pdf>] [--vlm-model <id>] [--python <path>]',
    detail: [
      'A document vision model reads each page picture and hands back marked-up',
      'text, and foundry assembles those answers into an EPUB. No Tesseract, no',
      'per-block labelling — the model sees the whole page at once.',
      '',
      'Models — pick one with --vlm-model:',
      '',
      ...VLM_MODELS.map((m) =>
        `  ${m.id === DEFAULT_VLM_MODEL_ID ? '*' : ' '} ${m.id.padEnd(17)} ${m.repo}`),
      '',
      '  (* is the default.) Each is asked in the prompt its own model card',
      '  documents, verbatim, and each answers in its own dialect. Adding one is a',
      '  registry entry in src/vlm/models.ts plus a parser in src/vlm/dialect.ts.',
      '',
      'dots-ocr IS THE DEFAULT, and it is the only one that answers with GEOMETRY:',
      'a JSON array of {bbox, category, text} in reading order over eleven',
      'categories. Everything the other three cannot do follows from that. Page',
      'headers and footers are dropped because the model says which blocks they',
      'are. A Picture is cropped out of the page render by its box and carried',
      'into the book with its Caption. Footnote blocks collect at the end of their',
      'CHAPTER, one paragraph per note. A centered epigraph is told from a',
      'paragraph by measuring against the BOOK\'S body column rather than the page.',
      'A paragraph that runs over a page turn is rejoined — by the words when the',
      'words say so, and by the ink of the render when they do not — and a word the',
      'column broke across the turn is fused using the book itself as the',
      'dictionary. Every element in the EPUB carries data-bf-page (the PDF page it',
      'was read from) and data-bf-cat (the model\'s own category), which is what',
      'lets a picker select "every footnote" or "everything on page 3" in a format',
      'that has no page concept of its own.',
      '',
      'THIS COMMAND NEEDS PYTHON. The models are MLX, which is Python, so the',
      'pages are read by `src/vlm/vlm_page.py` in one subprocess for the whole',
      'book — one model load, not one per page. The interpreter needs mlx-vlm and',
      'PyMuPDF in it; pass it with --python or FOUNDRY_VLM_PYTHON, or leave it and',
      'a `vlmtest` conda environment is looked for. Weights are pulled by mlx-vlm',
      'into the HuggingFace cache on first use. Python is needed even with',
      '--vlm-endpoint: the pages still have to be rasterised, and PyMuPDF is what',
      'does it.',
      '',
      '--vlm-endpoint sends the pages to an OpenAI-compatible server instead —',
      'the same verbatim prompt, the same 200 dpi render, temperature 0, twelve',
      'pages in flight. A chat endpoint is right here (ARCHITECTURE §4): a',
      'document VLM\'s published interface IS the chat template, and the MLX path',
      'reaches the same one through apply_chat_template. On MLX the pixel budget',
      'is capped at 2,000,000, which halves the per-page cost and is the same',
      'number the boxes are scaled with; a server uses its own processor config,',
      'so the model\'s cap is assumed there and the run states the frame it',
      'measured in.',
      '',
      '--readings banks every answer as it lands and re-reads only what is',
      'missing, so a killed run costs one page and a change to the parser or the',
      'assembler costs no GPU at all.',
      '',
      'A BANK THAT A FINISHED RUN LEFT BEHIND IS NOT A RUN TO RESUME. A run that',
      'writes its EPUB drops `completed.json` beside its readings, and the next',
      'run that finds that marker ARCHIVES the bank into `archived-<timestamp>/`',
      'and reads every page again — because ordering a conversion that already',
      'finished is ordering the work, not a replay of it. Without the marker the',
      'bank is an interrupted run and is resumed exactly as before. Nothing is',
      'ever deleted: a page costs GPU-minutes and a book costs hours.',
      '',
      '--reuse-readings overrides that and rebuilds the book from the banked',
      'answers. That is the deliberate free reconvert — iterating on the parser or',
      'the assembler over answers that are already known good. --fresh-readings is',
      'the opposite and the explicit form: archive and re-read whatever the marker',
      'says, for a caller whose own records know the conversion finished (a bank',
      'written before markers existed carries no marker). Passing both, or either',
      'without --readings, is refused rather than half-obeyed. Whichever of the',
      'three happens, the run says which in one sentence before it renders a page.',
      '',
      '--skip-pages 3,17,19-24 leaves pages out of the book. They are not',
      'rasterised, not read and not in the EPUB, so a page somebody deleted in a',
      'picker costs nothing. It is a SKIP, NOT A SUBSET: the PDF is not rewritten,',
      'so its sha256 — the identity --readings is keyed to — survives the',
      'curation, and every page that stays keeps its TRUE page number in',
      'data-bf-page. A page that is not a number, a page 0 and a backwards range',
      'are refused here; a page past the end of the document and a list covering',
      'the whole book are refused once the PDF has been opened, before anything',
      'is rendered. A paragraph is never joined across the hole: page 8 followed',
      'by page 12 is not a page turn, and the sentence a join would build there',
      'is one nobody wrote.',
      '',
      'Pages are rendered by PyMuPDF at 200 dpi. That is the resolution the models',
      'were measured at and it is not a setting (ARCHITECTURE §5).',
      '',
      'What comes out is an ordinary EPUB3: one XHTML document per chapter, a nav',
      'document, and a package. Chapters are PROPOSED by a deterministic rule and',
      '--chapters writes the proposals out as data for a person to confirm; the',
      'list over-includes on purpose, because an extra costs a click and a missed',
      'chapter cannot be recovered.',
      '',
      '--format txt writes readable plain text instead: chapter titles ruled with',
      '=, section headings with -, paragraphs separated by blank lines and never',
      'hard-wrapped, footnote references as [14] with the notes as [14] ... at the',
      'end of their chapter, and a picture as the page it was cropped from. It is',
      'the SAME BOOK — every rule above runs first and only the last stage differs',
      '— so a conversion whose answers are banked can be written out again as text',
      'with --reuse-readings for no GPU at all. An element with no plain-text rule',
      'stops the run and names its tag rather than arriving as a book quietly',
      'missing a table.',
      '',
      '--format pdf writes THE SCAN BACK OUT, made searchable. Every page of the',
      'input PDF is carried through untouched — same images, same bytes, same',
      'metadata — and the recognised text is drawn over it in rendering mode 3,',
      'which draws nothing. The file still looks exactly like the scan and now',
      'answers to search, select and copy. This is the evidentiary mode: what the',
      'page printed is what the layer says. Nothing that turns pages into a BOOK',
      'runs on this route — no chapters, no page-turn joins, no dehyphenation, no',
      'note markers, no reflow, no pictures — and the running heads and the page',
      'numbers are KEPT, because they are on the page. Text goes down verbatim,',
      'block by block, in the model\'s own reading order. It needs a dialect that',
      'answers with geometry (dots-ocr does, and it is the default); a prose',
      'dialect is refused, because there are no positions to place anything at. A',
      'page that could not be read gets no layer and is reported like any other.',
      'A stray character the layer\'s font cannot write — usually the model',
      'misreading a glyph — becomes U+FFFD and is reported by name, count and',
      'page rather than stopping the book or vanishing silently; past one in a',
      'thousand characters the run refuses instead, because at that scale the',
      'font does not cover the book\'s script and the layer would be holes.',
      '',
      '--out AND --format MUST AGREE. `--format txt --out book.epub` is refused,',
      'and so is the reverse: foundry does not rename a file somebody chose and',
      'does not ignore a flag somebody typed. An --out with no extension, or with',
      'one that names none of the formats, is the caller\'s business and is left',
      'alone. `--out` may never be `--pdf`, whatever the format: foundry reads the',
      'one and writes the other, and a scan overwritten by its own conversion is',
      'the single input that running the command again cannot recover.',
      '',
      'NOTHING DEGRADES SILENTLY. A page that came back empty, a page that hit the',
      'token cap while the model was still writing, a page whose answer does not',
      'parse and a block this program has no rule for are each named. For the',
      'markdown dialects that stops the run; for dots.ocr, whose answer is',
      'per-page structured data and whose answers are cached, the page is left out',
      'and reported BY NUMBER — in the log, in --chapters, and again on the last',
      'line of the run. What never happens is a page quietly guessed at.',
    ].join('\n'),
    options: [
      PDF_IN, OUT_PATH, VLM_FORMAT, VLM_MODEL, VLM_PYTHON, VLM_RENDERS, VLM_LANGUAGE,
      VLM_ENDPOINT, VLM_ENDPOINT_MODEL, VLM_CONCURRENCY, VLM_READINGS,
      VLM_FRESH_READINGS, VLM_REUSE_READINGS, VLM_SKIP_PAGES,
      VLM_CHAPTERS, VLM_STRIP_MARKERS,
    ],
    run: runVlmConvert,
  },
  {
    name: 'translate',
    summary: 'Translate a foundry EPUB with a local Ollama model: EPUB in, a second EPUB out.',
    usage: '--epub <book.epub> --to <lang> [--from <lang>] [--out <path>] [--model <name>] [--instructions <text>]',
    detail: [
      'Reads a book foundry converted and writes a SECOND BOOK beside it with the',
      'same structure, the same pictures and the same page provenance, and the',
      'text inside every category replaced by a translation. The input is never',
      'written to. Default --out puts the language tag before the extension:',
      'Buch.epub becomes Buch.en.epub.',
      '',
      'THE MODEL IS OLLAMA, AND OLLAMA IS SOMEBODY ELSE\'S SERVER. foundry sends it',
      'HTTP at --ollama (default http://localhost:11434) and does not start it,',
      'stop it, pull a model or configure it. A server that is not answering ends',
      'the run with the URL that was tried in the message; a model the server has',
      'not got ends it with the list of models the server HAS.',
      '',
      'WHY THIS READS AN EPUB AND NOT A PDF. Measured on an OCR\'d 1933 German',
      'book: paragraph-sized inputs translate well and page FRAGMENTS are',
      'catastrophic — a model handed half a sentence omits it, invents a',
      'completion for it, or hands the source language back untouched, and all',
      'three look like text. A foundry EPUB has already rejoined the paragraphs',
      'that ran over a page turn, so translating it block by block means that',
      'failure cannot happen here. A block is never split.',
      '',
      'WHICH BLOCKS. Everything foundry stamped with a category that has words in',
      'it: text, title, section-header, quote, footnote, caption, list-item and',
      'the chapter openings. THREE ARE SKIPPED AND COUNTED — table, formula and',
      'picture. A table is the vision model\'s own HTML, and a table whose columns',
      'quietly swapped in translation is worse than one nobody translated; a',
      'formula has no words in it. The counts are on the last line of the run. A',
      'picture\'s CAPTION is a block of its own and is translated.',
      '',
      'AN EPUB WITHOUT FOUNDRY\'S STAMPS IS REFUSED. This command replaces the text',
      'inside the categories foundry writes, so a publisher\'s EPUB has no blocks',
      'in it and the run would "succeed" by copying the book and changing its',
      'declared language — a file claiming to be an English edition that is',
      'entirely in German.',
      '',
      'INLINE MARKUP IS NEVER SENT TO THE MODEL. Emphasis, superscripts, footnote',
      'anchors and the print-page markers are replaced with opaque tokens before',
      'the request and put back from the ORIGINAL bytes afterwards, so no',
      'attribute is ever retyped by a language model. Asked to reproduce an',
      '<a epub:type="noteref" href="#fn12"> a model will occasionally hand back a',
      'reference to #fn13: a footnote pointing at the wrong note, in a book that',
      'renders perfectly.',
      '',
      'EVERY ANSWER IS VERIFIED MECHANICALLY, because prompt compliance is',
      'probabilistic and a rule that holds for 1,900 blocks out of 2,000 has',
      'failed a hundred times in one book. An answer is rejected when it is empty,',
      'when it drops, doubles, invents or crosses a marker, when it is under a',
      'quarter of the source\'s length (an omission — qwen2.5:14b\'s signature',
      'failure), when it is over three times it (commentary or repetition), or',
      'when it is the source handed back unchanged. A rejected block is asked',
      'again, twice, at the same fixed temperature.',
      '',
      'A BLOCK THAT FAILS THREE TIMES IS REFUSED BY NAME AND THE JOB FAILS — with',
      'the document, the block number, its page, its category, its opening words',
      'and what was wrong with the last answer, for every refused block. Nothing',
      'is written. A book that is 99% translated and looks finished is the worst',
      'thing this command could produce: nobody can find the missing 1%, and the',
      'file gets read and quoted as an edition.',
      '',
      '--model picks the translator. qwen3:32b is the default and is the best of',
      'the three measured; it can invent smoothing text and soften loaded',
      'vocabulary, which is why the verification exists and why --instructions',
      'does. qwen2.5:14b is roughly twice as fast and good for a draft, but omits',
      'silently. qwen2.5:7b inverted meanings — sentences whose translation said',
      'the opposite of the source, fluently — and should not be used for this at',
      'all. For a qwen3 model the request carries "think": false, because a',
      'reasoning pass on a translation is latency and nothing else; qwen2.5 models',
      'do not get the field, because Ollama rejects it on a model without thinking',
      'support.',
      '',
      '--instructions is appended to the system prompt verbatim, and it is the',
      'control that matters on a historical text: "Leave \'völkisch\'',
      'untranslated. Render racial terminology literally; do not soften it."',
      'Terminology is per-book and no default can be right about it.',
      '',
      'WHAT IS NOT TRANSLATED, DELIBERATELY: dc:title and dc:creator. The title is',
      'the book\'s NAME — somebody looking for this file is looking for the name on',
      'the German cover, and a library listing an invented English title for a',
      'book with no English edition is a catalogue that lies. dc:language becomes',
      '--to, and so does xml:lang on every chapter, because a document declaring',
      'the wrong language hyphenates by the wrong rules and reads aloud in the',
      'wrong voice. Contents entries are relabelled from the translated headings',
      'they were copied from, and any entry that cannot be PROVEN to be such a',
      'copy is left in the source language and reported rather than translated a',
      'second time — a contents page and a chapter heading that disagree is a book',
      'assembled from two editions.',
    ].join('\n'),
    options: [TR_EPUB_IN, TR_TO, TR_FROM, TR_OUT, TR_MODEL, TR_OLLAMA, TR_INSTRUCTIONS],
    run: runTranslate,
  },
  {
    name: 'doctor',
    summary: 'Probe every reading backend and say which one a run would use.',
    usage: '[--json] [--endpoint <url>]',
    detail: [
      'Answers one question: where would vlm-convert read pages RIGHT NOW, and',
      'why not anywhere faster? Four probes, concurrent, each reported with a',
      'detail a person can act on:',
      '',
      '  endpoint    GET <url>/models on the OpenAI-compatible server. The first',
      '              tier everywhere: vLLM in WSL, Docker, or another machine all',
      '              look identical from here. Probed at --endpoint, else the',
      '              settings URL, else http://localhost:8000/v1 (vLLM\'s default).',
      '  wsl-vllm    (Windows) a WSL distro whose named interpreter can import',
      '              vllm — a server COULD be started there. Nothing is started.',
      '  mlx         (Apple silicon) a local interpreter can import mlx_vlm.',
      '  rasteriser  a local interpreter can import fitz (PyMuPDF). EVERY run',
      '              needs this one, endpoint or not: the pages render locally.',
      '',
      'The chosen tier follows the settings mode (auto: first available;',
      'endpoint/mlx: that tier or nothing). It NAMES and never degrades: an',
      'explicit mode whose tier is down chooses null and the detail says what to',
      'fix — the next tier down is 10-100x slower and is not a thing to slide',
      'into silently.',
      '',
      `Settings are read from ${settingsPath()}`,
      '(FOUNDRY_CONFIG_DIR overrides the directory). Recognised keys, all under',
      '"backend": mode (auto|endpoint|mlx), endpointUrl, endpointModel,',
      'wslDistro, vllmPython, python. Flags beat settings everywhere; a value a',
      'setting supplied is logged on the runs that use it.',
      '',
      '--json prints the same facts as versioned JSON for the settings screen of',
      'a UI. Machine-consumed: fields are added, never renamed, without a',
      'version bump.',
    ].join('\n'),
    options: [
      { name: 'json', type: 'boolean', describe: 'Print the report as versioned JSON on stdout.' },
      {
        name: 'endpoint',
        type: 'string',
        placeholder: '<url>',
        describe: 'Probe this URL instead of the settings/default one.',
      },
    ],
    run: runDoctor,
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
