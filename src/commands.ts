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
import { epubFinal } from './epub/final.js';
import { epubMeta, EPUB_META_FIELDS, type EpubMetaField } from './epub/meta.js';
import { epubStamp } from './epub/stamp.js';
import { pdfMeta, PDF_META_FIELDS, type PdfMetaField } from './pdf/meta.js';
import { probeEndpoint, probeLocalPython, probeVllmLocal, probeWslVllm } from './backend/probe.js';
import { loadSettings, settingsPath, type FoundrySettings } from './backend/settings.js';
import { vlmConvert } from './vlm/convert.js';
import { DEFAULT_VLM_CONCURRENCY } from './vlm/endpoint.js';
import { DEFAULT_VLM_MODEL_ID, VLM_MODELS } from './vlm/models.js';
import { parsePageList } from './vlm/pages.js';
import { formatConflict, VLM_OUTPUT_FORMATS, type VlmOutputFormat } from './vlm/text-out.js';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_TRANSLATE_CONCURRENCY,
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

const TR_BANK: OptionSpec = {
  name: 'bank',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'Bank each answer here as it is accepted, and ask only for the blocks not in it.',
};

/** The one instruction the bank's key cannot express. See `bank.ts`. */
const TR_FRESH_BANK: OptionSpec = {
  name: 'fresh-bank',
  type: 'boolean',
  describe: 'Archive whatever --bank holds and ask the model for every block again.',
};

const TR_CONCURRENCY: OptionSpec = {
  name: 'concurrency',
  type: 'string',
  placeholder: '<n>',
  describe: `Requests in flight at once. Default ${DEFAULT_TRANSLATE_CONCURRENCY} — a starting point, not a measurement.`,
};

// ── epub-final ───────────────────────────────────────────────────────────────

const EF_EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub|dir>',
  describe: 'The working book: an EPUB file, or the directory one is unpacked into. Never written to.',
};

const EF_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<final.epub>',
  describe: 'Where the final EPUB is written. Required; foundry never invents a name.',
};

// ── epub-stamp ───────────────────────────────────────────────────────────────

const ES_EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub|dir>',
  describe: 'The book to stamp: an EPUB file, or an unpacked EPUB directory, which is stamped in place.',
};

const ES_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'Where the stamped book is written. Required for a file; refused for a directory.',
};

// ── epub-meta ────────────────────────────────────────────────────────────────

const EM_EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub|dir>',
  describe: "The book: an EPUB file, or an unpacked EPUB directory, which is edited in place.",
};

const EM_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'Where the edited book is written. Required for a file that is being changed.',
};

/**
 * One flag per Dublin Core field, generated from the same list the engine
 * writes from.
 *
 * Written as a loop rather than six literals so that the flag surface and the
 * fields that exist cannot drift: a field added to `EPUB_META_FIELDS` gets a
 * flag, a help line and a place in the report on the same commit, and one
 * removed cannot leave a flag behind that silently does nothing.
 */
const EM_FIELD_HELP: Record<EpubMetaField, string> = {
  title: "The book's name. Not translated, not derived from the filename, and it does not rename a file.",
  creator: 'The author, as the book itself gives the name.',
  language: 'dc:language, as a BCP-47 tag — en, de, pt-BR. Refused if it is not one.',
  publisher: 'The publisher of this edition.',
  date: 'The edition date. Written verbatim; EPUB wants ISO 8601 but does not enforce it.',
  identifier: 'The text of the dc:identifier the package names in unique-identifier. Its id is never touched.',
};

const EM_FIELDS: readonly OptionSpec[] = EPUB_META_FIELDS.map((field): OptionSpec => ({
  name: field,
  type: 'string',
  placeholder: '<text>',
  describe: EM_FIELD_HELP[field],
}));

// ── pdf-meta ─────────────────────────────────────────────────────────────────

const PM_PDF_IN: OptionSpec = {
  name: 'pdf',
  type: 'string',
  placeholder: '<file.pdf>',
  describe: 'The PDF to read. Never written to.',
};

const PM_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<file.pdf>',
  describe: 'Where the edited PDF is written. Required when a field is being set.',
};

const PM_FIELD_HELP: Record<PdfMetaField, string> = {
  title: 'The document title — what a viewer shows in Properties and in its window bar.',
  author: 'The author.',
  subject: "The document's subject line.",
  keywords: 'The keywords, verbatim. PDF has never standardised a separator, so yours is kept as typed.',
};

const PM_FIELDS: readonly OptionSpec[] = PDF_META_FIELDS.map((field): OptionSpec => ({
  name: field,
  type: 'string',
  placeholder: '<text>',
  describe: PM_FIELD_HELP[field],
}));

const META_JSON: OptionSpec = {
  name: 'json',
  type: 'boolean',
  describe: 'Print the metadata as versioned JSON on stdout — before and after any change.',
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

  /*
   * The bank flags, checked here because this is the argv layer.
   *
   * `--fresh-bank` is an instruction ABOUT A BANK, and without `--bank` there
   * is no bank for it to act on. Refused rather than ignored: a flag this
   * program drops on the floor is how somebody ends up believing they ordered a
   * fresh translation and got yesterday's answers back (ARCHITECTURE §8). The
   * engine refuses the same pair again, for a caller that is not this one.
   */
  const bankPath = optionalString(args, 'bank');
  const freshBank = flag(args, 'fresh-bank');
  if (freshBank && bankPath === undefined) {
    throw new UsageError('--fresh-bank is about the bank --bank names, and no --bank was given.');
  }

  // A count of requests, and the only readings of "0", "-2" and "four" are
  // mistakes. Refused by name rather than rounded up to something workable.
  const concurrency = optionalString(args, 'concurrency');
  if (concurrency !== undefined && !/^[1-9]\d*$/.test(concurrency)) {
    throw new UsageError(`--concurrency takes a positive whole number, not "${concurrency}"`);
  }

  const report = await translateEpub({
    epubPath,
    outPath,
    to,
    ...(bankPath !== undefined ? { bankPath } : {}),
    ...(freshBank ? { freshBank: true } : {}),
    ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
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
  const kept = report.wordless === 0
    ? ''
    : `, ${report.wordless} wordless block(s) kept as written`;
  const echoed = report.markerNotes === 0
    ? ''
    : `, ${report.markerNotes} answer(s) came back missing inline markup and were kept anyway`;
  // The blocks the model could not do at all. On the completion line for the
  // same reason the skipped tables are: this is the line somebody reads when
  // they come back to a run that took four hours, and a book with untranslated
  // blocks in it must say so there rather than only in the scroll.
  const stuck = report.keptUntranslated.length === 0
    ? ''
    : `, ${report.keptUntranslated.length} block(s) LEFT IN THE SOURCE LANGUAGE — the model could `
      + 'not translate them';
  // The requests are named separately from the blocks because they are no
  // longer the same number: a list, a quotation or a table goes in one request
  // and comes back as several blocks. Somebody reading a run that took four
  // hours wants both — the blocks say how much book, the requests say how much
  // GPU.
  const sent = report.chunks === report.blocks ? '' : ` in ${report.chunks} requests`;
  // What the bank saved, on the line somebody actually reads. A resumed run
  // must VISIBLY cost less than the run it resumed, or nobody can tell the
  // feature is working from a model that happened to be quick today.
  const banked = bankPath === undefined
    ? ''
    : `, ${report.fromBank} from the bank and ${report.answered} asked`;
  log(
    `translate: ${report.blocks} blocks${sent} in ${report.seconds.toFixed(1)}s `
    + `(${(report.blocks / Math.max(report.seconds, 0.001)).toFixed(2)} a second, ${report.model})`
    + `${banked}${struck}${asked}${kept}${echoed}${stuck}`,
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
// epub-final
// ═════════════════════════════════════════════════════════════════════════════

async function runEpubFinal(args: ParsedArgs): Promise<void> {
  const epubPath = requireString(args, 'epub', 'the working book to finish');
  const outPath = requireString(args, 'out', 'where the final EPUB is written');

  /*
   * Refused here, before a byte is read, exactly as `translate` refuses it. The
   * input is the WORKING copy — the only record of every cut somebody made —
   * and an output written over it destroys the thing the edition was made from,
   * including the marks that would have let it be made again.
   */
  if (path.resolve(outPath) === path.resolve(epubPath)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the working book and writes the `
      + 'edition; the working copy is where every cut lives, and a run that overwrites it '
      + 'cannot be run a second time.',
    );
  }

  const report = await epubFinal({ epubPath, outPath, log });

  // What was removed, on one line, because a person who cut four things wants
  // to see four things and everything the four dragged with them.
  const many = (n: number, one: string, more: string): string => `${n} ${n === 1 ? one : more}`;
  const parts = [many(report.cuts, 'element cut', 'elements cut')];
  if (report.notesDropped > 0) {
    parts.push(`${many(report.notesDropped, 'note', 'notes')} dropped with the reference that was cut`);
  }
  if (report.noteSectionsDropped > 0) {
    parts.push(`${many(report.noteSectionsDropped, 'empty footnote section', 'empty footnote sections')} removed`);
  }
  if (report.noterefsDemoted > 0) {
    parts.push(
      `${many(report.noterefsDemoted, 'reference number', 'reference numbers')} unlinked because `
      + 'the note it pointed at was cut',
    );
  }
  if (report.navRemoved > 0) {
    parts.push(`${many(report.navRemoved, 'contents entry', 'contents entries')} removed`);
  }
  if (report.navDemoted > 0) {
    parts.push(
      `${many(report.navDemoted, 'contents entry', 'contents entries')} kept as a label so the `
      + 'sub-entries under them survived',
    );
  }
  if (report.imagesDropped.length > 0) {
    parts.push(
      `${many(report.imagesDropped.length, 'image', 'images')} dropped `
      + `(${report.imagesDropped.join(', ')})`,
    );
  }
  if (report.pagesRehomed.length > 0) {
    parts.push(
      `${many(report.pagesRehomed.length, 'page marker', 'page markers')} re-homed `
      + `(${report.pagesRehomed.length === 1 ? 'page' : 'pages'} ${report.pagesRehomed.join(', ')})`,
    );
  }
  log(`epub-final: ${parts.join(', ')}`);

  /*
   * The integrity report. It is printed on EVERY run, including one with
   * nothing wrong, because "as exact as possible" is a claim and a claim
   * nobody can check is a claim nobody should believe. None of these numbers
   * stops the run — an unlinked marker is a fact about the scan, and a book
   * somebody cannot produce is worse than one with a stated gap.
   */
  log(
    `epub-final: ${many(report.noterefs, 'reference number', 'reference numbers')} `
    + `${report.noterefs === 1 ? 'links' : 'link'} to a note, ${report.unlinkedMarkers} stayed a `
    + `plain <sup> the emitter could not match; ${many(report.notes, 'note', 'notes')}, `
    + `${report.unreferencedNotes} with nothing pointing at ${report.unreferencedNotes === 1 ? 'it' : 'them'}`,
  );
  if (!report.cover) {
    /*
     * Stated rather than left to be noticed: a book with no cover is a grey
     * rectangle on every shelf. It is an absence to report and not a defect in
     * this command — nothing here can invent one, because the cover is a crop
     * out of the SCAN and this command has only the converted book.
     *
     * `vlm-convert --format epub` writes one now, so a book that reaches here
     * without one is one of three things: cast before covers existed, cast from
     * a run whose crop refused (that run said so by name), or a publisher's
     * EPUB imported without one.
     */
    log(
      'epub-final: this book declares NO COVER — it was cast before foundry wrote covers, or its '
      + 'conversion could not cut one. Re-run vlm-convert to give it one; nothing here can, because '
      + 'a cover comes off the scan',
    );
  }
  if (report.pagesLost.length > 0) {
    // Last, and loud: a page that is no longer in the book's own pagination is
    // the one thing here that a later citation cannot recover.
    log(
      `epub-final: ${many(report.pagesLost.length, 'PAGE MARKER IS GONE', 'PAGE MARKERS ARE GONE')} `
      + `— nothing survived on ${report.pagesLost.length === 1 ? 'page' : 'pages'} `
      + report.pagesLost.join(', '),
    );
  }
  process.stdout.write(`${report.outPath}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// epub-stamp
// ═════════════════════════════════════════════════════════════════════════════

async function runEpubStamp(args: ParsedArgs): Promise<void> {
  const epubPath = requireString(args, 'epub', 'the book to stamp');
  const outPath = optionalString(args, 'out');

  /*
   * Refused here, before a byte is read, exactly as `translate` and `epub-final`
   * refuse it. It is the one mistake this command cannot recover from: the input
   * is somebody's book and the output is the same book with attributes in it, so
   * an `--out` equal to `--epub` destroys the only copy of what was being read
   * the moment the write begins.
   */
  if (outPath !== undefined && path.resolve(outPath) === path.resolve(epubPath)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the one and writes the other; a `
      + 'directory working copy is stamped in place and takes no --out at all.',
    );
  }

  const report = await epubStamp({ epubPath, ...(outPath !== undefined ? { outPath } : {}), log });

  /*
   * THE FIRST LINE IS THE MACHINE-READABLE ONE. The app spawns this command on
   * import and again behind select mode's toggle, and reads these four numbers
   * off it to decide whether to reload a rendered chapter (app/electron/engine.ts,
   * `runEpubStamp`). The phrases "blocks stamped", "ids written" and "documents"
   * are that contract; the prose around them is not.
   */
  const many = (n: number, one: string, more: string): string => `${n} ${n === 1 ? one : more}`;
  const blocks = Object.values(report.stamped).reduce((sum, n) => sum + n, 0);
  log(
    `epub-stamp: ${many(report.documents, 'document', 'documents')}, ${blocks} blocks stamped, `
    + `${report.idsWritten} ids written, ${report.alreadyStamped} already stamped, `
    + `${report.pages} printed pages`,
  );

  const categories = Object.entries(report.stamped).sort((a, b) => b[1] - a[1]);
  if (categories.length > 0) {
    log(`epub-stamp: ${categories.map(([name, n]) => `${name} ${n}`).join(', ')}`);
    // Which layer decided, because that is the whole design and the number a
    // person checks when a category looks wrong: a book read almost entirely by
    // the default rule is a book whose markup said nothing, and one read by
    // declaration is one whose publisher did the work.
    const layers = Object.entries(report.byLayer).filter(([, n]) => n > 0);
    log(`epub-stamp: by ${layers.map(([name, n]) => `${name} ${n}`).join(', by ')}`);
  }
  if (report.titleOnlyDocuments.length > 0) {
    log(
      `epub-stamp: ${many(report.titleOnlyDocuments.length, 'document carries', 'documents carry')} `
      + 'no prose at all, so the headings on them are titles rather than chapter openings — '
      + report.titleOnlyDocuments.join(', '),
    );
  }
  if (report.pages === 0) {
    /*
     * Stated rather than left to be noticed, and it is not a defect. A
     * born-digital EPUB has no printed edition to be paginated against, and
     * nothing here will invent one: a page number this program made up would be
     * a claim about an edition nobody consulted and would look exactly like the
     * true kind. The blocks are addressable either way — the ids fall back to
     * the document's own name.
     */
    log(
      'epub-stamp: this book declares NO PRINTED PAGES — it carries no pagebreak markers, so no '
      + 'data-bf-page was written and the ids are named for their document instead',
    );
  }
  // The path is the RESULT, and for a directory the result is the directory
  // that was stamped where it stands.
  process.stdout.write(`${report.outPath}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// epub-meta
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A field's value for a person to read, with absence spelled out.
 *
 * `(none)` rather than an empty column, because "this package declares no
 * dc:publisher" and "this package declares an empty dc:publisher" are different
 * facts about a book and only one of them is legal.
 */
function metaLine(name: string, value: string | null): string {
  return `  ${name.padEnd(12)}  ${value === null ? '(none)' : value}`;
}

async function runEpubMeta(args: ParsedArgs): Promise<void> {
  const epubPath = requireString(args, 'epub', 'the book whose metadata is being read or written');
  const outPath = optionalString(args, 'out');

  /*
   * Refused here, before a byte is read, exactly as `translate`, `epub-final`
   * and `epub-stamp` refuse it. The input is somebody's book and the output is
   * the same book with six strings in it, so an `--out` equal to `--epub`
   * destroys the only copy of what is being read the moment the write begins.
   */
  if (outPath !== undefined && path.resolve(outPath) === path.resolve(epubPath)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the one and writes the other; a `
      + 'directory working copy is edited in place and takes no --out at all.',
    );
  }

  const set: Partial<Record<EpubMetaField, string>> = {};
  for (const field of EPUB_META_FIELDS) {
    const value = optionalString(args, field);
    if (value !== undefined) set[field] = value;
  }

  const report = await epubMeta({
    epubPath,
    ...(outPath !== undefined ? { outPath } : {}),
    set,
    log,
  });

  // Field by field, old → new, on stderr with the rest of the progress. Created
  // is said in a different sentence from updated: a field that was not there is
  // a gap being filled, and a field that was is an answer being corrected.
  for (const change of report.changes) {
    log(
      change.created
        ? `epub-meta: <${change.element}> CREATED — "${change.to}"`
        : `epub-meta: <${change.element}> "${change.from}" → "${change.to}"`,
    );
  }
  if (report.unchanged.length > 0) {
    log(
      `epub-meta: ${report.unchanged.join(', ')} already said exactly that, so nothing was written `
      + 'for them',
    );
  }
  /*
   * The refinements that now describe text that has moved. Named and NOT
   * edited: `file-as` for "Ian Kershaw" is "Kershaw, Ian", and no rule derives
   * one from the other for a name with a particle, a patronymic or one word in
   * it. A library sort key this program guessed at would be wrong invisibly, in
   * the one field whose whole job is to be read by a machine.
   */
  for (const stale of report.stale) {
    log(
      `epub-meta: dc:${stale.field} carries a <meta property="${stale.property}"> refinement `
      + `reading "${stale.value}", which still describes the OLD text. foundry does not derive one `
      + 'from the other and has left it exactly as it was.',
    );
  }
  if (report.changes.length === 0 && Object.keys(set).length > 0) {
    log('epub-meta: nothing changed — every field given already said what it was asked to say');
  }

  if (flag(args, 'json')) {
    /*
     * The RESULT, so it goes to stdout — the app spawns this command with
     * --json to populate its dialog and reads stdout for it, exactly as it does
     * for `doctor`. Machine-consumed: fields are added, never renamed, without
     * a version bump.
     */
    process.stdout.write(`${JSON.stringify({
      version: 1,
      kind: 'epub',
      path: report.outPath,
      opf: report.opfPath,
      uniqueIdentifier: report.uniqueIdentifier,
      inPlace: report.inPlace,
      written: report.written,
      fields: report.metadata,
      counts: report.counts,
      changes: report.changes,
      stale: report.stale,
    }, null, 2)}\n`);
    return;
  }

  if (report.written) {
    // The path is the RESULT, and for a directory the result is the directory
    // that was edited where it stands — `epub-stamp`'s rule.
    process.stdout.write(`${report.outPath}\n`);
    return;
  }

  // A read. The metadata IS the result, so it is what goes to stdout.
  const lines = EPUB_META_FIELDS.map((field) => metaLine(`dc:${field}`, report.metadata[field]));
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// pdf-meta
// ═════════════════════════════════════════════════════════════════════════════

async function runPdfMeta(args: ParsedArgs): Promise<void> {
  const pdfPath = requireString(args, 'pdf', 'the PDF whose metadata is being read or written');
  const outPath = optionalString(args, 'out');

  /*
   * Refused here, before a byte is read. It matters MORE for this command than
   * for the EPUB ones: this one re-emits the whole document through pdf-lib
   * rather than splicing it, so an `--out` equal to `--pdf` is a scan being
   * overwritten by a rewrite of itself while it is still being parsed.
   */
  if (outPath !== undefined && path.resolve(outPath) === path.resolve(pdfPath)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the one and writes the other, and this `
      + 'command rewrites the whole file rather than patching it, so there would be nothing left '
      + 'to read.',
    );
  }

  const set: Partial<Record<PdfMetaField, string>> = {};
  for (const field of PDF_META_FIELDS) {
    const value = optionalString(args, field);
    if (value !== undefined) set[field] = value;
  }

  const report = await pdfMeta({
    pdfPath,
    ...(outPath !== undefined ? { outPath } : {}),
    set,
    log,
  });

  // Named as the Info dictionary spells them — `/Title`, not `--title` — because
  // that is what a person will see in a viewer's Properties panel and in every
  // other tool that reads this file.
  const infoKey = (field: PdfMetaField): string => `/${field[0]!.toUpperCase()}${field.slice(1)}`;
  for (const change of report.changes) {
    log(
      change.created
        ? `pdf-meta: ${infoKey(change.field)} CREATED — "${change.to}"`
        : `pdf-meta: ${infoKey(change.field)} "${change.from}" → "${change.to}"`,
    );
  }
  if (report.unchanged.length > 0) {
    log(`pdf-meta: ${report.unchanged.join(', ')} already said exactly that, so nothing was written`);
  }
  if (report.changes.length === 0 && Object.keys(set).length > 0) {
    log('pdf-meta: nothing changed — every field given already said what it was asked to say');
  }

  if (flag(args, 'json')) {
    process.stdout.write(`${JSON.stringify({
      version: 1,
      kind: 'pdf',
      path: report.outPath,
      written: report.written,
      fields: report.metadata,
      changes: report.changes,
    }, null, 2)}\n`);
    return;
  }

  if (report.written) {
    process.stdout.write(`${report.outPath}\n`);
    return;
  }

  const lines = [
    ...PDF_META_FIELDS.map((field) => metaLine(infoKey(field), report.metadata[field])),
    metaLine('/Creator', report.metadata.creator),
    metaLine('/Producer', report.metadata.producer),
    metaLine('pages', String(report.metadata.pages)),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
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
      'THE COVER IS THE FIRST PAGE THE BOOK CONTAINS, rendered whole — not',
      'necessarily page 1. Under --skip-pages 1-6 those pages are never rasterised',
      'at all, so the cover is page 7; and a page that survived the skip but',
      'carried nothing is skipped over too, because a blank leaf makes a white',
      'cover. It is declared three ways, since readers disagree about which they',
      'honour: a cover-image manifest property, the old <meta name="cover">, and a',
      'cover document first in the spine so the cover is VISIBLE when the book is',
      'opened rather than only a thumbnail in a library grid. It gets no contents',
      'entry: it is not a chapter. A run that cannot cut one writes the book',
      'anyway and says which page it failed on. EPUB only — a text file has',
      'nowhere to put an image and a searchable PDF already is the pages.',
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
    usage: '--epub <book.epub> --to <lang> [--from <lang>] [--out <path>] [--model <name>]'
      + ' [--instructions <text>] [--bank <file.jsonl>] [--concurrency <n>]',
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
      'it: text, title, section-header, quote, footnote, caption, list-item, the',
      'chapter openings, and the cells of a table. TWO ARE SKIPPED AND COUNTED —',
      'formula and picture. A formula has no words in it and every edit to it is',
      'damage; a picture is a cropped PNG, and its CAPTION is a block of its own',
      'and IS translated. The counts are on the last line of the run.',
      '',
      'A TABLE USED TO BE THE THIRD SKIP AND IS NOT ANY MORE. The old reason was',
      'sound: a table is the vision model\'s own HTML, and a table whose columns',
      'quietly swapped in translation is worse than one nobody translated, because',
      'it looks fine. That risk is gone because the structure never leaves this',
      'process. The model is sent rows of words with | between the cells — no',
      'tags, no attributes, no cell boundaries it could move — and the answer is',
      'read back by position into the cells the words came out of. A row that',
      'comes back with the wrong number of cells is refused mechanically and the',
      'table is asked for again, one cell at a time. Structure a model cannot see',
      'is structure a model cannot rearrange.',
      '',
      'WHAT TRAVELS IN ONE REQUEST. A whole list, a whole quotation or a whole',
      'table, up to about a printed page; longer ones are cut into runs of',
      'consecutive items. An item of a list translated on its own has lost the',
      'list, and six items each rendered in whatever construction the model chose',
      'for that item do not read as a list; a table cell without its column header',
      'is often untranslatable in principle — "Zahl" over years and "Zahl" over',
      'member counts are different English words. Everything else is still one',
      'block per request, exactly as before.',
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
      'TWO GUARDS, AND THEY ARE THE OBVIOUS TWO. An answer under a quarter of the',
      'source\'s length is a summary or a dropped half (qwen2.5:14b\'s signature',
      'failure); one over three times it is a ramble. Both are rejected and the',
      'block is asked again, twice, at the same fixed temperature. Everything else',
      'the model returns is WRITTEN AS GIVEN — an answer identical to its source, a',
      'code fence (peeled), an answer that came back missing an <em> (noted in the',
      'log and kept). The engine guards the TEXT, which cannot be recovered, and',
      'no longer guards the FORM, which can be fixed by hand or ignored.',
      '',
      'A BLOCK THAT FAILS THREE TIMES STAYS IN THE SOURCE LANGUAGE — named in the',
      'log with its document, block number, page, category and opening words, and',
      'listed again at the end. The book is still written. That reversed for a',
      'measured reason: block 8 of a 1933 scan is HV111$007458S, a library',
      'accession number stamped on the flyleaf, and no model will ever translate',
      'it — refusing the job over it threw away 455 translated blocks and four',
      'hours of GPU. What still refuses outright is a run where NOTHING passed,',
      'because that book would be its own source text with a new dc:language on',
      'it: a lie about the file that looks exactly like a success.',
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
      '--bank NAMES AN ANSWER FILE, AND A KILLED RUN COSTS WHAT WAS IN FLIGHT.',
      'Every accepted answer is appended and fsynced the moment it is accepted,',
      'so a run that dies at block 400 of 456 — a crash, an Ollama restart, the',
      'app closing, somebody pressing stop — has 399 answers on disk and the next',
      'run pays for what is missing. Without it a translation holds everything in',
      'memory and writes the book at the very end, which is how 152 translated',
      'blocks of a real 456-block book became nothing at all.',
      '',
      'THE KEY IS THE QUESTION, NOT THE POSITION. An answer is reused only if the',
      'exact same thing would be asked again: the block\'s own text, the model,',
      'both languages and --instructions, hashed together. So editing one',
      'paragraph re-translates that paragraph and nothing else; changing --model',
      'or --instructions correctly re-translates everything, because every answer',
      'would have been different; inserting or reordering blocks costs nothing;',
      'and a paragraph that appears twice in a book is asked once. A block the',
      'model could NOT do is never banked — a refusal is a fact about a run, not',
      'an answer, and freezing it into the file would stop a better model ever',
      'being asked about that paragraph.',
      '',
      'A chunk with some parts already banked is still sent WHOLE. The banked',
      'parts keep their banked answers and only the missing ones are read out of',
      'the reply — a list item sent alone has lost the list, which is the defect',
      'chunking exists to prevent, and it would be a different question anyway. A',
      'chunk whose parts are all banked is never sent at all.',
      '',
      '--fresh-bank archives the whole file into `archived-<timestamp>/` beside',
      'it and asks for every block again. It is the one instruction the key',
      'cannot express — a person wanting the SAME question asked a second time,',
      'because a model is not deterministic. Nothing is ever deleted, and',
      '--fresh-bank without --bank is refused rather than half-obeyed. There is',
      'no completion marker here and vlm-convert\'s --readings needs one: keyed by',
      'the question rather than the page, a bank knows for itself when a run',
      'would ask something new.',
      '',
      `--concurrency puts N requests in flight at once, default `
      + `${DEFAULT_TRANSLATE_CONCURRENCY}. Ollama`,
      'batches concurrent requests and a serial run leaves the GPU idle between',
      'blocks: 456 blocks at two seconds each is fifteen minutes of mostly',
      'waiting. THE DEFAULT IS A STARTING POINT AND NOT A MEASUREMENT — unlike',
      '--vlm-concurrency, whose 12 is a measured knee — because the right number',
      'is a property of your GPU and your model\'s size. The log stops arriving in',
      'order and the counts do not: `block N/M` counts blocks FINISHED and',
      '`requests done` counts chunks finished, so neither number ever goes',
      'backwards. Order in the BOOK is unaffected — every block is spliced by its',
      'own position in its own document, whatever order the answers land in. A',
      'server error still ends the run at once, and the error reported is the',
      'first one that happened, not the last one to arrive.',
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
    options: [
      TR_EPUB_IN, TR_TO, TR_FROM, TR_OUT, TR_MODEL, TR_OLLAMA, TR_INSTRUCTIONS,
      TR_BANK, TR_FRESH_BANK, TR_CONCURRENCY,
    ],
    run: runTranslate,
  },
  {
    name: 'epub-final',
    summary: 'Finish a curated book: cuts applied, what they orphaned tidied, the edition written.',
    usage: '--epub <book.epub|dir> --out <final.epub>',
    detail: [
      'The terminal step. It takes the working copy of a book — the cast EPUB with',
      'whatever a person marked for removal still marked — and writes the EDITION:',
      'the file somebody would hand to a library. The input is never written to.',
      '',
      '--epub TAKES A DIRECTORY AS WELL AS A FILE. The app keeps the working copy',
      'unpacked and never rezips it until this moment, because a cut writes one',
      'chapter file of a few kilobytes where a repack of a 20 MB scan costs 20 MB',
      'an edit. A directory with a mimetype and a META-INF/container.xml in it is',
      'an unpacked EPUB; anything else is refused by name rather than read as one.',
      '',
      'EVERY ELEMENT CARRYING data-bf-cut IS REMOVED, and a cut container takes',
      'its children with it. That is the whole of the instruction — a cut lives in',
      'ONE place, an attribute on the element, so there is no second record of it',
      'to disagree with.',
      '',
      'THEN WHAT THE CUT LEFT DANGLING IS TIDIED, none of which is validated',
      'anywhere else in foundry:',
      '',
      '  - A footnote whose only reference was cut GOES WITH IT. The note',
      '    annotates a sentence the book no longer contains; keeping it would',
      '    leave a numbered remark at the end of a chapter pointing at nothing.',
      '    A note that NEVER had a reference is left exactly alone and counted —',
      '    it was there before this run and it is a fact about the scan.',
      '  - A footnotes section holding nothing but its <hr/> is removed. A rule',
      '    with white space under it is something a reader sees.',
      '  - A contents entry whose target this run removed is removed. An entry',
      '    that pointed nowhere BEFORE the run is left exactly as it was. An',
      '    entry with surviving sub-entries keeps them: its link becomes a plain',
      '    label instead of the entry disappearing with its children.',
      '  - An image the book used to point at and no longer does is dropped from',
      '    the package and from the OPF manifest. One nothing ever pointed at is',
      '    left alone, because dropping it would be a decision nobody ordered.',
      '  - A PAGE MARKER IS RE-HOMED RATHER THAN LOST. foundry emits a page\'s',
      '    <span epub:type="pagebreak"> inside the FIRST block of that page, so',
      '    cutting that block deletes the page from the book\'s own pagination and',
      '    nothing else records where it began. The marker moves to the next',
      '    surviving block on the same page. If nothing on the page survives the',
      '    page really is gone, and the run says which page by number.',
      '',
      'TWO ATTRIBUTES ARE STRIPPED AND TWO ARE KEPT. data-bf-cut and data-bf-id',
      'mean nothing outside this program and go. data-bf-page, data-bf-cat and the',
      'pagebreak spans STAY: page provenance is what makes a scan citable, it is',
      'invisible to a reader, and it is what every later pass reads.',
      '',
      'THE INTEGRITY REPORT IS PRINTED ON EVERY RUN, because "as exact as',
      'possible" is a claim and a claim nobody can check is a claim nobody should',
      'believe. How many reference numbers link to a note; how many stayed a plain',
      '<sup> because the emitter could not match one — that is deliberate, a',
      'marker is matched to a note by page and printed number and no link beats a',
      'wrong one; how many notes nothing points at; whether the book declares a',
      'cover — vlm-convert --format epub writes one, so a book with none was cast',
      'before covers existed or its conversion could not cut one.',
      '',
      'THE FILE IS WRITTEN ANYWAY. None of those numbers stops the run: they are',
      'facts about the scan, and a book somebody cannot produce is worse than one',
      'with a stated gap. What IS refused: an input that is not a foundry book (a',
      'publisher\'s EPUB has no marks in it and never will), an input that cannot',
      'be read, and an --out equal to --epub — the working copy is where every cut',
      'lives, and a run that overwrites it cannot be run a second time.',
      '',
      'What comes out is the input book: mimetype first and stored, every member',
      'nobody edited written back with the exact bytes, method and checksum it',
      'arrived with. The only entries that differ are the documents a cut touched,',
      'the nav and the package.',
    ].join('\n'),
    options: [EF_EPUB_IN, EF_OUT],
    run: runEpubFinal,
  },
  {
    name: 'epub-stamp',
    summary: "Read a publisher's EPUB and stamp foundry's categories, ids and pages into it.",
    usage: '--epub <book.epub|dir> [--out <book.epub>]',
    detail: [
      'A born-digital EPUB from a publisher carries none of foundry\'s stamps, so',
      'every command that reads a foundry book refuses it by name, select mode',
      'outlines nothing, and the inspector shows no categories. This reads the',
      'structure the file ALREADY STATES and writes it down as data-bf-cat,',
      'data-bf-id and — where the book has them — data-bf-page.',
      '',
      'A PUBLISHER\'S EPUB IS NOT A DEGRADED SCAN; IT IS A BETTER SOURCE. The',
      'vision route has to infer structure from ink, because a photograph of a',
      'page is all it has. An EPUB\'s markup already states the structure, and',
      'EPUB 3 semantics state it explicitly. Nothing here guesses at anything the',
      'file says for itself.',
      '',
      'A DIRECTORY IS STAMPED IN PLACE and a FILE IS NOT. The directory form is',
      'the app\'s working tree — foundry\'s own unpacked copy, the thing every edit',
      'already writes to — and mutating it is the point. A file is somebody\'s',
      '.epub, so --out is required and an --out equal to --epub is refused:',
      'foundry never writes over an input. Passing --out with a directory is',
      'refused too, rather than ignored.',
      '',
      'ONLY WHAT IS MISSING IS WRITTEN, attribute by attribute. A book already',
      'carrying data-bf-cat keeps every one of them — a category corrected by',
      'hand in the inspector is not something a later pass gets to overrule — and',
      'a cast book that predates data-bf-id gets ids and nothing else. Running it',
      'twice changes nothing the second time, which is what makes running it on',
      'every import safe.',
      '',
      'THE CATEGORY IS INFERRED IN LAYERS, MOST CERTAIN FIRST, and where two',
      'layers disagree the earlier one wins:',
      '',
      '  1. THE PUBLISHER\'S OWN SEMANTICS — epub:type and the DPUB-ARIA role.',
      '     footnote/endnote/rearnote and doc-footnote/doc-endnote become',
      '     footnote; epigraph and pullquote become quote; title, fulltitle,',
      '     covertitle, halftitle and subtitle become title; bridgehead becomes',
      '     section-header; credit becomes caption. This is a declaration, not an',
      '     inference, and it beats the element\'s own tag. Tokens that name',
      '     apparatus rather than a block — footnotes, endnotes, toc, landmarks,',
      '     page-list, pagebreak, noteref, backlink — say "not a block" and are',
      '     never stamped, while their CHILDREN are judged on their own: an',
      '     <ol epub:type="endnotes"> is the note apparatus and its',
      '     <li epub:type="endnote"> children are the notes.',
      '  2. ELEMENT SHAPE — blockquote is a quote and so is the <p> inside it,',
      '     matching how the emitter stamps both; li, dt and dd are list items and',
      '     so are the ul, ol and dl over them; figure and a bare img are a',
      '     picture; figcaption and a table\'s caption are a caption; a table, or',
      '     the wrapper a table sits alone inside, is a table; h1-h6 is a heading',
      '     whose kind layer 3 decides.',
      '  3. POSITION — the FIRST heading in a spine document is the chapter',
      '     opener (data-bf-cat="chapter", foundry\'s own value, the picker\'s',
      '     "Chapter Openings"), and later headings are section-header. A document',
      '     with NO PROSE ON IT AT ALL is not a chapter — a half-title, a part',
      '     divider, a dedication leaf — so its headings become title instead, and',
      '     the run names those documents.',
      '  4. DEFAULT — a leaf p, div or pre carrying words is text.',
      '',
      'AN ELEMENT MATCHING NONE OF THESE IS NOT STAMPED. A <div> wrapping a',
      'chapter is a container, not a block, and inventing a category for it would',
      'put a box around the whole page in select mode; the leaf test is what',
      'refuses it, because a container has structure under it. Nothing inside a',
      '<nav> is stamped either, and the nav document is skipped whole: a contents',
      'page is the book\'s apparatus, and stamping it would hand the translator',
      'every chapter title a second time.',
      '',
      'IDS ARE ALWAYS WRITTEN WHERE THERE ARE NONE, counting ELEMENTS and not',
      'blocks — a <ul> and its <li> are two elements and get two ids, or one id',
      'would name two elements, which is invalid XHTML and unaddressable besides.',
      'p<page>-<n> where the page is known, exactly as vlm-convert writes it;',
      'c<document>-<n> where it is not, the token taken from the member\'s own name',
      'so that moving a chapter renames nothing. Both are unique across the whole',
      'book, and an id the book already contains is never minted a second time.',
      '',
      'PAGE PROVENANCE IS KEPT AND NEVER INVENTED. Many publisher EPUBs carry',
      '<span epub:type="pagebreak"> for the printed edition\'s pagination, with the',
      'number in title, aria-label, a pb-N id or the marker\'s own text; where they',
      'exist the blocks after each one carry that data-bf-page, exactly as a cast',
      'book does, and that is what makes a quotation citable. Where they do not',
      'exist THE ATTRIBUTE IS SIMPLY ABSENT and the run says so. A page number',
      'this program made up would be a claim about an edition nobody consulted,',
      'and it would look exactly like the true kind.',
      '',
      'WHAT IS REFUSED: an input that cannot be read; a directory with no mimetype',
      'and META-INF/container.xml in it, which is not an unpacked EPUB; an archive',
      'that is a ZIP but not an EPUB; a book with an empty spine; a file input',
      'with no --out; an --out equal to --epub; and --out on a directory input.',
      '',
      'What comes out of the file form is the input book: mimetype first and',
      'stored, every member nobody stamped written back with the exact bytes,',
      'method and checksum it arrived with. The directory form writes only the',
      'documents that gained an attribute.',
    ].join('\n'),
    options: [ES_EPUB_IN, ES_OUT],
    run: runEpubStamp,
  },
  {
    name: 'epub-meta',
    summary: "Read or correct a book's Dublin Core metadata: title, creator, language, publisher, date, identifier.",
    usage: '--epub <book.epub|dir> [--out <book.epub>] [--json] [--title <text>] [--creator <text>]'
      + ' [--language <bcp47>] [--publisher <text>] [--date <text>] [--identifier <text>]',
    detail: [
      "Six strings in the package document. A cast book's metadata is whatever",
      'vlm-convert was told, which for a scan is usually the PDF\'s filename and',
      'nothing else; an imported publisher\'s EPUB has real metadata and may still',
      'have it wrong. This reads it, and writes the fields it is given.',
      '',
      'WITH NO SETTERS IT ONLY READS. --json prints the package\'s metadata as',
      'versioned JSON on stdout — which is how the app populates its dialog — and',
      'without --json the same facts are printed for a person. Nothing is written,',
      'no --out is needed, and the file is not touched.',
      '',
      'ONLY WHAT IS GIVEN MOVES. A run passing --publisher changes exactly the',
      'publisher: dc:title is not rewritten, not renormalised and not re-indented.',
      'The run says field by field what became what, and says which fields were',
      'CREATED rather than updated — a created field had no answer at all, and',
      'that is a different event from one that had a wrong answer.',
      '',
      'THE PACKAGE IS EDITED BY SOURCE OFFSET, never re-serialised. Only the text',
      'inside the elements named is replaced, so every other field, attribute,',
      'comment, namespace declaration and byte in the file survives exactly as it',
      'was. Rebuilding a package from parsed values would regenerate the manifest,',
      'the spine and the rendition properties out of foundry\'s idea of them, and',
      'everything the original carried that foundry has no field for would vanish',
      '— silently, in a document nobody reads and every reading system trusts.',
      'This is the same technique translate already uses to write dc:language, and',
      'dc:language is written here through that very code, so the two commands',
      'cannot drift into writing the same field two different ways.',
      '',
      'A FIELD THAT IS NOT THERE IS CREATED, and that is the hard half: plenty of',
      'books carry no dc:publisher and no dc:date to overwrite. A new element goes',
      'inside <metadata>, after the last Dublin Core element already there, in the',
      'namespace prefix this file\'s own declaration binds, indented to match its',
      'siblings — all three read off the file rather than assumed, because an OPF',
      'from another toolchain indents with tabs or binds the Dublin Core namespace',
      'to a prefix that is not "dc". A package that binds it nowhere is refused',
      'rather than given an element in an undeclared prefix, which is not',
      'well-formed XML and is a book some readers would then refuse entirely.',
      '',
      'dc:identifier IS NAMED BY THE PACKAGE, not found by position:',
      '<package unique-identifier="pub-id"> points at <dc:identifier id="pub-id">.',
      '--identifier rewrites the TEXT of the one the package names and never its',
      'id, because splicing an element\'s content leaves its start tag alone by',
      'construction. Where that link is broken already — no unique-identifier, or',
      'one naming an id no dc:identifier carries — the run REFUSES and says which',
      'half is missing, rather than rewriting whichever identifier comes first. A',
      'missing dc:identifier is never created either: one written now would carry',
      'no id and so would not be the book\'s identifier however it was spelled.',
      '',
      'EPUB 3 REFINEMENTS ARE NEVER ORPHANED. <meta refines="#id"> elements point',
      'at metadata ids, and nothing here writes, removes or renumbers an id —',
      'updates do not touch a start tag and insertions carry no id at all. What a',
      'refinement CAN become is stale: correct a dc:creator and its file-as still',
      'sorts the book under the old name. Those are NAMED IN THE RUN and left',
      'alone, because "Kershaw, Ian" is not derivable from "Ian Kershaw" in the',
      'general case and a sort key this program guessed at would be wrong',
      'invisibly.',
      '',
      'A DIRECTORY IS EDITED IN PLACE and a FILE IS NOT — epub-stamp\'s rule, for',
      'epub-stamp\'s reason. The directory form is the app\'s working tree, the copy',
      'every edit already writes to. A file is somebody\'s .epub, so --out is',
      'required WHEN THE RUN WRITES and an --out equal to --epub is refused;',
      'passing --out with a directory is refused too, rather than ignored. Reading',
      'needs no --out at all.',
      '',
      'FILENAMES DO NOT FOLLOW THE TITLE. Correcting dc:title changes the book\'s',
      'metadata and moves no file: the paths are in somebody\'s recents, in',
      'whatever else they have pointed at them, and in a sync client\'s index.',
      'Renaming files to match a corrected title is a deliberate gesture and is',
      'not this command.',
      '',
      'WHAT IS REFUSED, BY NAME: an input that cannot be read; a package with no',
      '<metadata> element, or an empty one; a --language that is not a BCP-47 tag',
      '(the same refusal translate --to gives, from the same table); an empty',
      'value for any field, because blanking dc:title is not a correction; a field',
      'the package declares MORE THAN ONCE, since --creator says nothing about',
      'which of two authors is being corrected and the wrong one rewritten reads',
      'exactly like the right one; a file input with no --out when a field is',
      'being set; an --out equal to --epub; and --out on a directory input.',
    ].join('\n'),
    options: [EM_EPUB_IN, EM_OUT, META_JSON, ...EM_FIELDS],
    run: runEpubMeta,
  },
  {
    name: 'pdf-meta',
    summary: "Read or correct a PDF's Info dictionary: title, author, subject, keywords.",
    usage: '--pdf <file.pdf> [--out <file.pdf>] [--json] [--title <text>] [--author <text>]'
      + ' [--subject <text>] [--keywords <text>]',
    detail: [
      'The four Info-dictionary fields a document has as a DOCUMENT rather than as',
      'an artifact of the tool that made it. With no setters it only reads: --json',
      'prints the dictionary as versioned JSON on stdout, which is how the app',
      'populates its dialog, and without --json the same facts are printed for a',
      'person along with the /Creator and /Producer it will not write.',
      '',
      'THIS COMMAND REWRITES THE WHOLE FILE, and that is said here rather than',
      'left to be discovered. It is the opposite of what epub-meta does one',
      'command over, and of what vlm-convert --format pdf does to this same',
      'format: the document is parsed by pdf-lib, one dictionary is edited, and',
      'pdf-lib writes a NEW file from its own object model — objects renumbered,',
      'the cross-reference table rebuilt, streams re-emitted, and anything pdf-lib',
      'does not model gone.',
      '',
      'That is acceptable HERE and nowhere else, for one reason: --out is the',
      'WORKING PDF, and the project keeps the file that came in, byte for byte, in',
      'archive/ forever. The working copy is derived and can be made again from',
      'the original at any time. The alternative — an incremental update appending',
      'an Info dict and a new trailer by hand, which is the technique the text',
      'layer uses — is cross-reference stream parsing and a hand-built trailer a',
      'strict reader rejects if one offset is wrong, and it would be a second,',
      'subtler PDF writer to maintain beside the one that already exists.',
      '',
      'WHAT IS NOT WRITTEN, DELIBERATELY: /Producer, /Creator, /CreationDate and',
      '/ModDate. Those are statements about the software chain, and rewriting them',
      'would be foundry claiming to have produced somebody\'s scan. pdf-lib stamps',
      'its own Producer and a fresh ModDate given half a chance, and it is stopped',
      'from doing so — a command whose whole purpose is to write exactly the',
      'fields it was given must not quietly write two it was not.',
      '',
      'XMP IS NOT TOUCHED. A PDF can carry the same facts twice, in the Info',
      'dictionary and in an XMP packet, and readers disagree about which wins.',
      'foundry writes the Info dictionary — what every viewer\'s Properties panel',
      'shows and what every indexer reads first — and leaves an XMP packet it did',
      'not write alone, because a half-updated pair is worse than a consistent old',
      'one: the file would state two different titles and which one a program',
      'believed would depend on the program.',
      '',
      '--keywords is written VERBATIM, as one string. PDF has never standardised a',
      'separator, so commas, semicolons or spaces are the caller\'s business and',
      'come out exactly as they went in.',
      '',
      'WHAT IS REFUSED, BY NAME: a --pdf that cannot be read; a document pdf-lib',
      'cannot open, which for a scan usually means it is encrypted, and foundry',
      'does not strip a password it was not given; an empty value for any field,',
      'because a document titled nothing reads differently from one that never',
      'said; a run that sets a field with no --out; and an --out equal to --pdf,',
      'which here would destroy the document while it was being parsed.',
    ].join('\n'),
    options: [PM_PDF_IN, PM_OUT, META_JSON, ...PM_FIELDS],
    run: runPdfMeta,
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
