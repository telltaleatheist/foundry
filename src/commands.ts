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
import { dumpBlocks } from './vlm/blocks-dump.js';
import { buildBookFile } from './vlm/book-run.js';
import { compileBook } from './vlm/compile.js';
import { vlmConvert } from './vlm/convert.js';
import { explodeEpub } from './vlm/epub-explode.js';
import { replaysCompletedBank, vlmRead } from './vlm/read.js';
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
  describe: 'What --out is written as. Default epub; txt is plain text; pdf reprints the scan as real text.',
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
  describe: 'Read every page again, marker or no marker, and start any half-finished re-read over.',
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

/**
 * The curation, which is a file rather than a flag because there is no number of
 * flags that could carry it: it is one line per block somebody decided
 * something about.
 */
const VLM_OVERLAY: OptionSpec = {
  name: 'overlay',
  type: 'string',
  placeholder: '<file.json>',
  describe: 'Decisions to apply: struck blocks, categories, corrected text, and the book\'s chapters.',
};

/**
 * A transform's answers, put in place of the blocks' own words as the documents
 * are written — `DotsBookOptions.records` in `src/vlm/dots-book.ts` argues the
 * whole design, and `src/translate/records.ts` carries the format.
 *
 * The file is `translate --records`' product. This is the other half of it: a
 * translated book is CAST, out of the same bank, through the same reflow,
 * chapters, curation, edition rules and format fork as the source book, with
 * different words in the blocks. dc:language and every xml:lang come from
 * --language, because a file of sentences does not declare a language.
 */
const VLM_RECORDS: OptionSpec = {
  name: 'records',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'A transform\'s words, substituted per block as the book is written. From translate --records.',
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

/**
 * ── THE CAST AND THE EDITION ARE TWO DIFFERENT BOOKS, AND THIS IS THE SWITCH ──
 *
 * Without it this command writes the CAST: the working book, which is a
 * workbench. Everything a person struck at the parse is already gone from it —
 * `applyOverlay` drops those blocks before either format fork — but a struck
 * FOOTNOTE is still there, wearing `data-bf-cut="1"`, and so is every attribute
 * that exists so an app can address an element: `data-bf-id`, `data-bf-src`,
 * `data-bf-note`. That is deliberate and it is not a compromise. A struck note
 * cannot be removed from the working book without renumbering every note after
 * it behind the person who struck one, and a curator has to be able to SEE what
 * they decided, strike it through, and press Delete again to bring it back.
 *
 * With it this command writes the EDITION: the file somebody would hand to a
 * library. A struck note's `<aside>` is never written; the reference numbers
 * that pointed at it keep the digit the page printed and lose their link (no
 * link beats a wrong one, which is this program's rule for an unmatched marker
 * everywhere else); a chapter that lost every note loses its footnotes section,
 * because a rule with white space under it is something a reader sees; and the
 * four editing attributes are not written. `data-bf-page` and `data-bf-cat`
 * STAY — page provenance is what makes a scan citable, it is invisible in a
 * reader, and every later pass reads it.
 *
 * WHY IT IS A FLAG OF THE CONVERSION RATHER THAN A COMMAND OF ITS OWN.
 * `foundry epub-final` is the command of its own, it does all of this to a book
 * that already exists, and it is not going anywhere: it is what an app runs when
 * it has an EPUB in its hands. But `--format txt` never becomes an EPUB — it is
 * the same assembled documents with their tags stripped — so a note removed from
 * a zip afterwards is still a paragraph of text in the plain-text export. The
 * only place that fixes every format at once is the assembly, and that is here.
 *
 * DEFAULT OFF, and the default is what everything except an export passes: a
 * cast written today is byte-for-byte the cast written yesterday.
 */
const VLM_FINAL: OptionSpec = {
  name: 'final',
  type: 'boolean',
  describe: 'Write the edition rather than the working book: struck notes gone, no editing stamps.',
};

// ── vlm-read ─────────────────────────────────────────────────────────────────

/**
 * Where the reading goes, and it is REQUIRED here.
 *
 * The same flag `vlm-convert` takes, and on that command it is optional because
 * a conversion can be ordered without banking anything. On this one the bank is
 * the entire product: a run with nowhere to put it would spend the GPU-hours and
 * leave nothing behind.
 */
const VR_READINGS: OptionSpec = {
  name: 'readings',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'Where the reading is banked, page by page as each answer lands. Required — it is the product.',
};

const VR_LANGUAGE: OptionSpec = {
  name: 'language',
  type: 'string',
  placeholder: '<bcp47>',
  describe: "The book's language, recorded in the marker for whoever renders it later. Not used here.",
};

// ── vlm-blocks ───────────────────────────────────────────────────────────────

const VB_READINGS: OptionSpec = {
  name: 'readings',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'The bank of page answers to read the blocks out of. Read, never written.',
};

const VB_PDF_IN: OptionSpec = {
  name: 'pdf',
  type: 'string',
  placeholder: '<file.pdf>',
  describe: 'Only for a bank that recorded no render sizes: the pages are measured again. Never written to.',
};

const BOOK_READINGS: OptionSpec = {
  name: 'readings',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'The bank of page answers to reflow. Read, never written.',
};

/**
 * THE OTHER SOURCE A BOOK CAN BE MADE OF — a publisher's own container.
 *
 * An imported EPUB is never read by a model into a bank: a bank models pages and
 * an EPUB has none, and re-reading real text through a vision model would trade
 * exact data for a guess at it (docs/RENDERER.md §6). What it becomes instead is
 * the same book file, exploded straight out of the spine — which is why this
 * lives on `vlm-book` rather than in a command of its own. One book file, one
 * command that writes it, two things it can be written from.
 */
const BOOK_EPUB: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<file.epub>',
  describe: 'An imported EPUB to explode into the book file instead of a bank. Read, never written.',
};

const BOOK_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<book.jsonl>',
  describe: 'Where the book file is written. One row per block, in reading order.',
};

/**
 * The archived original, and it buys ONE thing.
 *
 * Not the pages — those are in the bank — but the pixels of the figures, which
 * are in no bank and never can be. Optional because a book with no pictures in
 * it needs nothing from the PDF, and because the imported-EPUB route has no PDF
 * to name; without it the figures are simply not cut and the run says so.
 */
const BOOK_PDF: OptionSpec = {
  name: 'pdf',
  type: 'string',
  placeholder: '<file.pdf>',
  describe: 'The archived original, for cutting the figures out of. Read, never written.',
};

const BOOK_LANGUAGE: OptionSpec = {
  name: 'language',
  type: 'string',
  placeholder: '<bcp47>',
  describe: 'The book\'s language, as a BCP-47 tag. Declared, not detected. Defaults to en.',
};

const BOOK_PYTHON: OptionSpec = {
  name: 'python',
  type: 'string',
  placeholder: '<path>',
  describe: 'The interpreter with PyMuPDF in it, for the figure crops. Also FOUNDRY_VLM_PYTHON.',
};

// ── vlm-compile ──────────────────────────────────────────────────────────────

const COMPILE_BOOK: OptionSpec = {
  name: 'book',
  type: 'string',
  placeholder: '<book.jsonl>',
  describe: 'The book file to compile. Read, never written — a derived one compiles like any other.',
};

/**
 * The product, and it is the ONLY place the format is said.
 *
 * `vlm-convert` has a `--format` flag because it can be asked for four different
 * things out of one bank and the ask has to be explicit. A book file compiles into
 * two, the extension names one of them unambiguously, and a flag that could
 * disagree with the filename would be a second way to state one decision.
 */
const COMPILE_OUT: OptionSpec = {
  name: 'out',
  type: 'string',
  placeholder: '<file.epub|.txt>',
  describe: 'Where the book is written. The extension chooses the format: .epub or .txt.',
};

const COMPILE_IMAGES: OptionSpec = {
  name: 'images',
  type: 'string',
  placeholder: '<dir>',
  describe: 'The figures this book\'s rows name, cut when it was made. Read, never written.',
};

const COMPILE_TITLE: OptionSpec = {
  name: 'title',
  type: 'string',
  placeholder: '<title>',
  describe: 'dc:title. Left out, the name of the file being written stands in for it.',
};

const COMPILE_AUTHOR: OptionSpec = {
  name: 'author',
  type: 'string',
  placeholder: '<name>',
  describe: 'dc:creator. Left out, none is written — an author is never inferred.',
};

// ── translate ────────────────────────────────────────────────────────────────

const TR_EPUB_IN: OptionSpec = {
  name: 'epub',
  type: 'string',
  placeholder: '<book.epub>',
  describe: 'The foundry-converted EPUB to translate. Never written to.',
};

/**
 * ── THE BOOK FILE AS THE SOURCE ─────────────────────────────────────────────
 *
 * `--epub` hands this command a RENDERING of the book and asks it to find the
 * words again: unzip, walk the elements `dots-book.ts` stamped, read each
 * block's provenance off the `data-bf-src` attribute it wrote. `--book` hands it
 * the book (docs/BOOK-FILE.md) — one row per block, each with its own text and
 * with an ID that is that block's name for as long as the book exists.
 *
 * WHAT CHANGES IS THE KEY OF EVERY RECORD. On this route a record's position is
 * the ROW'S ID rather than a coordinate in the reading bank, which is what lets
 * the app materialise a derived book file in the target language with the
 * parent's ids kept verbatim (docs/RENDERER.md §4) — the same names on both
 * sides of the translation, so an aligned view is two files that agree and
 * striking a translated paragraph is the same op as striking the source one.
 *
 * IT IS THE MATERIALISED STATE OF A POSITION, and that is what makes translating
 * from an edited book possible at all: the app replays the ops into a book file
 * and hands that over, so a struck row is simply not in what this command reads.
 *
 * `--records` IS REQUIRED BESIDE IT and `--source-records` is refused: a chain's
 * parent words are already IN a book file at a position under a translation, so
 * the question keys hash them without a second file being consulted.
 */
const TR_BOOK_IN: OptionSpec = {
  name: 'book',
  type: 'string',
  placeholder: '<book.jsonl>',
  describe: 'Translate the rows of this book file instead of an EPUB. Read, never written.',
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
  describe: 'Ask the model for every block again, into a bank that replaces --bank only on success.',
};

/**
 * The GPU is given back by default, and this is how to say don't.
 *
 * See `translateEpub`: a finished run asks Ollama to unload the model, because
 * a book is thousands of requests and the five-minute idle timer would other-
 * wise hold twenty gigabytes against nothing on the card the reading server
 * wants next. That is right for the machine this app runs on and wrong for an
 * Ollama somebody else is also using, which is a fact only the person typing
 * the command knows.
 */
const TR_KEEP_MODEL: OptionSpec = {
  name: 'keep-model',
  type: 'boolean',
  describe: 'Leave the model loaded when the run ends (for an Ollama shared with other work).',
};

/**
 * ── RECORDS, NOT A BOOK, AND THIS IS THE SWITCH ─────────────────────────────
 *
 * Without it this command writes a SECOND EPUB: the same container, the same
 * pictures, the same page provenance, with a translation inside every stamped
 * element. That shipped, it works, and it is a dead end for everything that
 * comes after a translation — because the product is a FILE. Striking a
 * paragraph out of the translated edition, correcting one sentence of it,
 * casting it as plain text, translating it again into a third language: every
 * one of those is a decision about a BLOCK, and in an EPUB there are no blocks
 * left to decide about, only markup to re-parse and re-splice.
 *
 * With it the same blocks are translated and the answers are written down as
 * RECORDS — one JSONL row per flowing block, keyed by the block's position in
 * the reading bank, in the same spelling `data-bf-src` writes and an overlay
 * target uses. No EPUB is written and --out is refused. The book is made later,
 * by `vlm-convert --records`, which puts those words into the same pipeline
 * that already applies the curation, the chapters and the edition rules — so a
 * translated book is CAST rather than converted, and every decision a person
 * has made about the source reaches it for free.
 *
 * THE FILE IS ITS OWN BANK, which is why --bank is refused beside it: an
 * unchanged block has an unchanged question, its key is already in the records
 * file, and it is never asked again. One file to copy onto a branch, one file
 * to sweep with the step.
 *
 * AND IT RE-ASKS THE BOOK ONCE. The masking moves one stage earlier — the
 * flowing block's own text rather than rendered XHTML — so the masked source is
 * a different string and the key is a different key. A book translated to an
 * EPUB yesterday and to records today is paid for twice, once, and never again.
 */
const TR_RECORDS: OptionSpec = {
  name: 'records',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'Write RECORDS here instead of an EPUB: one row per block, keyed by its position.',
};

/**
 * ── THE CHAIN — TRANSLATE THE TRANSLATION ───────────────────────────────────
 *
 * The user's own case: click the English translation, then click translate to
 * Hungarian, and get German → English → Hungarian.
 *
 * With this, the question about each block is asked of the PARENT'S answer
 * rather than of the book's own words: per position, the source text is the
 * parent records file's newest row, and the book's own text is the fallback for
 * a position the parent never answered — a block it refused, a table it
 * skipped. The key hashes the masked PARENT text, so correcting one English
 * record re-asks exactly the Hungarian blocks that record feeds and nothing
 * else. That precision is why a chain is records-native and was never buildable
 * over EPUBs, where "the source" is a whole file.
 *
 * PASS --from YOURSELF, and pass the parent's target language. Nothing here
 * reads a language out of a records file: a file of sentences is not a
 * declaration, and a guess would put "German → Hungarian" on a prompt holding
 * English.
 */
const TR_SOURCE_RECORDS: OptionSpec = {
  name: 'source-records',
  type: 'string',
  placeholder: '<file.jsonl>',
  describe: 'Translate the records in this file rather than the book\'s own words — a chain. Read only.',
};

/**
 * The app's binding of a records file to the reading it was made from, carried
 * into every row and never interpreted here — `Overlay.generation`'s contract
 * exactly. It exists so the app can tell records about THIS bank from records
 * left beside a book that has since been read again.
 */
const TR_GENERATION: OptionSpec = {
  name: 'generation',
  type: 'string',
  placeholder: '<token>',
  describe: 'Written into every record row and never read here. The app\'s binding to a reading.',
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
   * Refused before a page renders: off macOS the only reading path is an
   * endpoint, and letting a run that must read proceed without one ends in "no
   * Python with MLX was found" — a true sentence that points a Windows user at
   * entirely the wrong problem.
   *
   * ASKED ONLY OF A RUN THAT WILL ACTUALLY READ, and that condition is the whole
   * of this comment. `--reuse-readings` over a bank a run completed is a
   * RENDERING: it loads no model, opens no socket and leaves the bank byte for
   * byte as it found it (`read.ts`). Demanding a reading backend for it refused
   * a job over a thing it was never going to touch — and on a fresh Windows
   * install, where settings.json names no endpoint yet, that made generating a
   * second format out of a finished reading impossible while costing nobody a
   * second of GPU. The check now asks whether this run is that, and stands aside
   * when it is.
   *
   * IT STAYS WHERE IT IS IN `runVlmRead`. A read genuinely needs a backend
   * before it does anything at all, so there the refusal is the first true
   * sentence about the run rather than a guess about one.
   *
   * A replay that turns out to have a HOLE in it — a page the completed bank
   * carries no answer for — is not refused here either, and must not be: it goes
   * on to render, discovers the hole and names the page. That is the truer
   * sentence about that run, and it is one a person can act on.
   *
   * AND `--reuse-readings` OVER A BANK NO RUN COMPLETED IN STILL REACHES THIS
   * REFUSAL, which is worth stating because the case changed underneath it. That
   * run used to be a genuine read — `openReadingsBank` answered `resume` and the
   * missing pages went to a model — so demanding a backend for it was exactly
   * right. It is now a refusal: the flag reads nothing in any state of the bank,
   * and a bank with no marker is told so by name (`readings.ts`). So this check
   * no longer stops a run that would have been fine; it stops a run that was
   * about to be stopped anyway, one sentence earlier, and off macOS with no
   * endpoint configured that sentence is about the machine rather than about the
   * bank. Left alone deliberately: the alternative is standing aside for every
   * `--reuse-readings` whether or not it can replay, which is this check
   * guessing at what `openReadingsBank` will decide instead of asking the marker
   * — the exact second opinion `replaysCompletedBank` exists to avoid. The app
   * cannot reach it at all, because `planConversion` refuses an unfinished
   * reading before a job is queued (app/electron/workspace.ts).
   */
  const readingsPath = optionalString(args, 'readings');
  const replaying = replaysCompletedBank({
    ...(readingsPath !== undefined ? { readingsPath } : {}),
    reuseReadings,
  });
  if (!replaying && endpoint === undefined && process.platform !== 'darwin') {
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
    ...(readingsPath !== undefined ? { readingsPath } : {}),
    ...(freshReadings ? { freshReadings: true } : {}),
    ...(reuseReadings ? { reuseReadings: true } : {}),
    ...(skipPages !== undefined ? { skipPages: parsePageList(skipPages, '--skip-pages') } : {}),
    ...(optionalString(args, 'overlay') ? { overlayPath: optionalString(args, 'overlay')! } : {}),
    ...(optionalString(args, 'chapters') ? { chaptersPath: optionalString(args, 'chapters')! } : {}),
    // Passed only when it was asked for, so a book made of its own words hands
    // the engine the options object it has always been handed — see VLM_RECORDS.
    ...(optionalString(args, 'records') ? { recordsPath: optionalString(args, 'records')! } : {}),
    stripNoteMarkers: flag(args, 'strip-note-markers'),
    // Passed only when it was asked for, so a cast's options are the ones they
    // have always been — see VLM_FINAL for what the edition is.
    ...(flag(args, 'final') ? { final: true } : {}),
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
  if (report.unjoinedTurns.length > 0) {
    /*
     * THE SEAMS, COUNTED — the one thing about a converted book this program
     * decided NOT to decide, and it is on the completion line because a
     * decision nobody can see is a decision nobody can correct.
     *
     * This used to be settled by measuring the page's ink: a paragraph that
     * carried on filled its last line to the margin, one that ended stopped
     * short of it. It read well and it was not trustworthy — a footnote sits
     * at the bottom of the page too — so the join is now the bank's answer or
     * it does not happen (`docs/DERIVED-BOOK.md` §2).
     *
     * A BIG NUMBER HERE IS NOT A DEFECT, and the sentence is worded so that
     * nobody reads it as one. The textual test asks whether the next page
     * opens lowercase, which is false of every character in a script that has
     * no case at all — Chinese, Japanese, Arabic, Hebrew — so such a book gets
     * a seam at every page turn in it and this line will read in the hundreds.
     * That is the honest price of not guessing, it was accepted when the rule
     * was made, and the fix is a person joining them where they can see what
     * they are joining.
     */
    const turns = report.unjoinedTurns;
    log(
      `vlm-convert: ${turns.length} page turn(s) left as two paragraphs — the words do not say the `
      + 'paragraph carried on, and nothing here reads the page to guess (p'
      + `${turns.slice(0, 12).join(', p')}${turns.length > 12 ? `, and ${turns.length - 12} more` : ''}`
      + '). Join them by hand where the book wanted them joined; a book set in a caseless script '
      + 'will show one at every turn, which is a known cost and not a fault in this run.',
    );
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
// vlm-read
// ═════════════════════════════════════════════════════════════════════════════

async function runVlmRead(args: ParsedArgs): Promise<void> {
  // Both paths are read first, so a half-typed command is answered by what is
  // missing from it rather than by a fact about this machine's backends.
  const pdfPath = requireString(args, 'pdf', 'the PDF to read');
  const readingsPath = requireString(
    args,
    'readings',
    'where the reading is banked — it is what this command produces',
  );

  const concurrency = optionalString(args, 'vlm-concurrency');
  if (concurrency !== undefined && !/^[1-9]\d*$/.test(concurrency)) {
    throw new UsageError(`--vlm-concurrency takes a positive whole number, not "${concurrency}"`);
  }
  const skipPages = optionalString(args, 'skip-pages');

  /*
   * The two bank flags contradict each other, exactly as they do for
   * vlm-convert. There is no "and no --readings" case to refuse here: the bank
   * IS this command's product, so `--readings` is required and `requireString`
   * has already said so by the time either flag could matter.
   */
  const freshReadings = flag(args, 'fresh-readings');
  const reuseReadings = flag(args, 'reuse-readings');
  if (freshReadings && reuseReadings) {
    throw new UsageError(
      '--fresh-readings and --reuse-readings say opposite things about the same bank. Pass one.',
    );
  }

  const settings: FoundrySettings = loadSettings();
  const endpointFromSettings =
    settings.backend?.mode === 'endpoint' ? settings.backend.endpointUrl : undefined;
  const endpoint = fromFlagOrSettings(args, 'vlm-endpoint', endpointFromSettings, 'backend.endpointUrl');
  const endpointModel = endpoint === undefined
    ? optionalString(args, 'vlm-endpoint-model')
    : fromFlagOrSettings(args, 'vlm-endpoint-model', settings.backend?.endpointModel, 'backend.endpointModel');
  const python = fromFlagOrSettings(args, 'python', settings.backend?.python, 'backend.python');

  // The same refusal vlm-convert makes, for the same reason: off macOS the only
  // reading path is an endpoint, and a run allowed to proceed without one ends
  // in "no Python with MLX was found", which points a Windows user at entirely
  // the wrong problem.
  if (endpoint === undefined && process.platform !== 'darwin') {
    throw new Error(
      'no reading backend for this run: the local MLX path is Apple silicon only, and no endpoint '
      + 'was named. Pass --vlm-endpoint <url> (e.g. a vLLM server), or set backend.mode to '
      + `"endpoint" with backend.endpointUrl in ${settingsPath()}. `
      + '`foundry doctor` reports what this machine has.',
    );
  }

  const report = await vlmRead({
    pdfPath,
    readingsPath,
    modelId: optionalString(args, 'vlm-model') ?? DEFAULT_VLM_MODEL_ID,
    ...(python !== undefined ? { python } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(endpointModel !== undefined ? { endpointModel } : {}),
    ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
    ...(optionalString(args, 'renders') ? { rendersDir: optionalString(args, 'renders')! } : {}),
    ...(freshReadings ? { freshReadings: true } : {}),
    ...(reuseReadings ? { reuseReadings: true } : {}),
    ...(skipPages !== undefined ? { skipPages: parsePageList(skipPages, '--skip-pages') } : {}),
    ...(optionalString(args, 'language') !== undefined
      ? { language: optionalString(args, 'language')! }
      : {}),
    log,
  });

  const { timings } = report;
  const perPage = timings.inferenceSeconds / report.inferredPages;
  const rate = report.inferredPages === 0
    ? 'every page was already banked'
    : `${report.inferredPages} read this run at ${perPage.toFixed(1)}s a page, `
      + `${(60 / perPage).toFixed(1)} pages a minute`;
  const struck = report.skippedPages.length === 0
    ? ''
    : `, ${report.skippedPages.length} skipped (${report.skippedPages.join(', ')})`;
  const peak = report.peakRssBytes === null
    ? ''
    : `, peak ${(report.peakRssBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  log(
    `vlm-read: ${report.pages.length} pages in ${timings.totalSeconds.toFixed(1)}s (${rate})${struck}${peak}`,
  );
  if (report.unreadable.length > 0) {
    // Last, and named again: a page with no answer in the bank is a page every
    // rendering made from that bank will be missing.
    log(
      `vlm-read: ${report.unreadable.length} PAGE(S) HAVE NO ANSWER — `
      + report.unreadable.map((p) => p.number).join(', '),
    );
  }

  // The bank is the RESULT, so its path is what goes to stdout — the same
  // contract every other command that writes a file keeps.
  process.stdout.write(`${report.readingsPath}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// vlm-blocks
// ═════════════════════════════════════════════════════════════════════════════

async function runVlmBlocks(args: ParsedArgs): Promise<void> {
  const settings: FoundrySettings = loadSettings();
  const endpointFromSettings =
    settings.backend?.mode === 'endpoint' ? settings.backend.endpointUrl : undefined;
  const python = fromFlagOrSettings(args, 'python', settings.backend?.python, 'backend.python');

  const dump = await dumpBlocks({
    readingsPath: requireString(args, 'readings', 'the bank of page answers to read the blocks out of'),
    ...(optionalString(args, 'pdf') ? { pdfPath: optionalString(args, 'pdf')! } : {}),
    modelId: optionalString(args, 'vlm-model') ?? DEFAULT_VLM_MODEL_ID,
    ...(python !== undefined ? { python } : {}),
    /*
     * The one thing this flag decides is which pixel budget an OLD bank's boxes
     * were measured in, and it decides it exactly as vlm-convert does — nothing
     * is contacted. A bank written by this version records the budget beside
     * every answer and the flag is never consulted at all.
     */
    viaEndpoint: optionalString(args, 'vlm-endpoint') !== undefined || endpointFromSettings !== undefined,
    log,
  });

  // The blocks ARE the result, so they go to stdout, as versioned JSON — this
  // command exists to be spawned. Fields are added, never renamed, without a
  // version bump, exactly as for epub-meta --json.
  process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
}

async function runVlmBook(args: ParsedArgs): Promise<void> {
  const pdfPath = optionalString(args, 'pdf');
  const python = optionalString(args, 'python');
  /*
   * ── WHICH SOURCE, and exactly one of them ──────────────────────────────────
   *
   * `runTranslate`'s rule, for the same reason one command up: a bank and an
   * EPUB are two different things to make a book OUT OF, they mint their block
   * names differently (`b<page>-<order>` against `e-<n>`, docs/BOOK-FILE.md §4),
   * and a run handed both would silently choose which spelling every op in the
   * project is keyed to. A run handed neither has nothing to make a book from.
   */
  const epubPath = optionalString(args, 'epub');
  const readingsPath = optionalString(args, 'readings');
  if (epubPath !== undefined && readingsPath !== undefined) {
    throw new UsageError(
      '--readings and --epub are two different books to make: a bank is the model\'s page answers '
      + 'and an EPUB is a publisher\'s own container, and the blocks they produce do not wear the '
      + 'same names. Pass one.',
    );
  }
  if (epubPath === undefined && readingsPath === undefined) {
    throw new UsageError(
      '--readings <bank.jsonl> or --epub <file.epub>: this run has nothing to make a book from.',
    );
  }
  const outPath = requireString(args, 'out', 'where the book file is written');
  if (epubPath !== undefined) {
    const language = optionalString(args, 'language');
    await explodeEpub({
      epubPath,
      outPath,
      // ABSENT AND NOT DEFAULTED, which is the difference between this route and
      // the bank's. A bank records no language of its own, so the command states
      // one and `en` is the documented default; an EPUB's package DECLARES the
      // language, and defaulting over a publisher's own declaration would be this
      // program overruling the source it is here to retain.
      ...(language !== undefined ? { language } : {}),
      log,
    });
    return;
  }
  await buildBookFile({
    readingsPath: requireString(args, 'readings', 'the bank of page answers to reflow into a book'),
    outPath,
    // The same default and the same word as vlm-convert's: declared, never
    // detected, and one spelling of the default across the two commands that
    // write a language into a document.
    language: optionalString(args, 'language') ?? 'en',
    // Passed only where they were asked for, so a run with no figures to cut
    // hands the engine the options object it has always been handed.
    ...(pdfPath !== undefined ? { pdfPath } : {}),
    ...(python !== undefined ? { python } : {}),
    log,
  });
}

/**
 * `vlm-compile` — a book file in, the finished document out.
 *
 * Every argument is a path or a piece of metadata; there is no switch that
 * changes what the book SAYS, which is the whole point of compiling from a book
 * file rather than from a bank. What the rows say is what comes out.
 */
async function runVlmCompile(args: ParsedArgs): Promise<void> {
  const imagesDir = optionalString(args, 'images');
  const title = optionalString(args, 'title');
  const author = optionalString(args, 'author');
  compileBook({
    bookPath: requireString(args, 'book', 'the book file to compile'),
    outPath: requireString(args, 'out', 'where the finished book is written'),
    // Passed only where they were asked for, so a run with nothing to say about
    // the book's metadata hands the compiler the options object it has always
    // been handed.
    ...(imagesDir !== undefined ? { imagesDir } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    log,
  });
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
  /*
   * ── WHICH SOURCE, and exactly one of them ──────────────────────────────────
   *
   * `--epub` is a rendering of the book and `--book` is the book (see
   * `TR_BOOK_IN`). They do not name their blocks the same way, so a run handed
   * both would silently choose which spelling every record in the file gets, and
   * a run handed neither has nothing to translate. Refused here, at the argv
   * layer, and again in the engine for a caller that is not this one.
   */
  const bookPath = optionalString(args, 'book');
  const epubPath = optionalString(args, 'epub');
  if (bookPath !== undefined && epubPath !== undefined) {
    throw new UsageError(
      '--epub and --book are two spellings of the same book — the EPUB is a rendering of the rows '
      + 'the book file holds — and they name their blocks differently. Pass one.',
    );
  }
  if (bookPath === undefined && epubPath === undefined) {
    throw new UsageError('--epub <book.epub> or --book <book.jsonl>: this run has nothing to translate.');
  }
  const to = requireString(args, 'to', 'the language to translate into');

  /*
   * WHICH OF THE TWO PRODUCTS THIS RUN IS FOR — see TR_RECORDS for the whole
   * distinction. Every contradiction between them is refused here, at the argv
   * layer, and again in the engine for a caller that is not this one.
   */
  const recordsPath = optionalString(args, 'records');
  const named = optionalString(args, 'out');
  if (recordsPath !== undefined && named !== undefined) {
    throw new UsageError(
      `--records writes records and no book, so the EPUB at --out ${named} would never be written. `
      + 'A path this command accepts and does not write to is a file somebody goes looking for.',
    );
  }
  /*
   * A BOOK FILE WRITES NO BOOK. There is no derived book file for this command
   * to write — the app materialises that one, out of these records and the parent
   * book together (docs/RENDERER.md §4) — so an `--out` on this route names a
   * file nothing would ever put anything in, and a default one would invent it.
   */
  if (bookPath !== undefined && recordsPath === undefined) {
    throw new UsageError(
      '--book needs --records: this command writes no book file, so a run reading one has nowhere '
      + 'to put what it produces. The derived book in the target language is made by the app.',
    );
  }
  const outPath = recordsPath !== undefined || epubPath === undefined
    ? undefined
    : named ?? defaultTranslationOut(epubPath, to);

  /*
   * Refused here, before a byte is read. `--out` equal to `--epub` is the one
   * mistake this command cannot recover from: the input is somebody's converted
   * book, the run takes hours, and an output written over it destroys the only
   * copy of the thing being translated — including the source text every
   * refusal message would have pointed at.
   */
  const input = epubPath ?? bookPath!;
  if (outPath !== undefined && path.resolve(outPath) === path.resolve(input)) {
    throw new UsageError(
      `--out ${outPath} is the input itself. foundry reads the one and writes the other; a book `
      + 'overwritten by its own translation is the single input this command cannot get back.',
    );
  }
  /*
   * The same refusal for the records file, and it is a sharper one: the input
   * is a book and the output is JSONL, so this is not a mistake anybody makes
   * by accident — but the cost of it is the converted book itself, and this
   * command's whole promise is that the input is never written to. It is sharper
   * again for `--book`, where BOTH files are JSONL and the input is a book
   * somebody's whole chain of edits was replayed into.
   */
  if (recordsPath !== undefined && path.resolve(recordsPath) === path.resolve(input)) {
    throw new UsageError(
      `--records ${recordsPath} is the input itself. The records file is written to; the book is not.`,
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
   *
   * IN RECORDS MODE THE RECORDS FILE IS THE BANK, so `--fresh-bank` is about
   * that file and `--bank` beside it is a second cache that could answer
   * nothing the first one does not.
   */
  const bankPath = optionalString(args, 'bank');
  const freshBank = flag(args, 'fresh-bank');
  if (recordsPath !== undefined && bankPath !== undefined) {
    throw new UsageError(
      '--bank and --records: the records file already IS the bank — an unchanged block has an '
      + 'unchanged question, its key is in the file, and it is never asked again. Pass one.',
    );
  }
  if (freshBank && bankPath === undefined && recordsPath === undefined) {
    throw new UsageError(
      '--fresh-bank is about the file --bank or --records names, and neither was given.',
    );
  }
  const sourceRecords = optionalString(args, 'source-records');
  if (sourceRecords !== undefined && bookPath !== undefined) {
    throw new UsageError(
      '--source-records and --book: a book file at a position under a translation already HOLDS the '
      + 'parent\'s answers — the app materialises it that way (docs/RENDERER.md §4) — so the words '
      + 'this run translates are the parent\'s and the question keys already hash them. The parent\'s '
      + 'records file is keyed by the reading\'s coordinates and would answer for none of these ids.',
    );
  }
  if (sourceRecords !== undefined && recordsPath === undefined) {
    throw new UsageError(
      '--source-records names the parent translation this one is a chain from, and only a --records '
      + 'run can consume one: without it this command translates the words in the book it was given.',
    );
  }
  const generation = optionalString(args, 'generation');
  if (generation !== undefined && recordsPath === undefined) {
    throw new UsageError(
      '--generation is written into record rows, and without --records this run writes a book. '
      + 'Nothing would carry it.',
    );
  }

  // A count of requests, and the only readings of "0", "-2" and "four" are
  // mistakes. Refused by name rather than rounded up to something workable.
  const concurrency = optionalString(args, 'concurrency');
  if (concurrency !== undefined && !/^[1-9]\d*$/.test(concurrency)) {
    throw new UsageError(`--concurrency takes a positive whole number, not "${concurrency}"`);
  }

  const report = await translateEpub({
    ...(epubPath !== undefined ? { epubPath } : {}),
    ...(bookPath !== undefined ? { bookPath } : {}),
    ...(outPath !== undefined ? { outPath } : {}),
    ...(recordsPath !== undefined ? { recordsPath } : {}),
    ...(sourceRecords !== undefined ? { sourceRecordsPath: sourceRecords } : {}),
    ...(generation !== undefined ? { generation } : {}),
    to,
    ...(bankPath !== undefined ? { bankPath } : {}),
    ...(freshBank ? { freshBank: true } : {}),
    ...(flag(args, 'keep-model') ? { keepModel: true } : {}),
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
  // The same sentence for either cache, because in records mode the records
  // file IS the bank and a person reading the line wants the same two numbers.
  const banked = bankPath === undefined && recordsPath === undefined
    ? ''
    : `, ${report.fromBank} from the bank and ${report.answered} asked`;
  // What actually landed in the file, which is not the same number: a position
  // whose row already says this is not written again, and one a person
  // corrected is left exactly as they left it.
  const rows = recordsPath === undefined
    ? ''
    : `, ${report.recordsWritten} record(s) written`
      + (report.recordsHumanKept === 0
        ? ''
        : ` and ${report.recordsHumanKept} left as a person corrected them`);
  log(
    `translate: ${report.blocks} blocks${sent} in ${report.seconds.toFixed(1)}s `
    + `(${(report.blocks / Math.max(report.seconds, 0.001)).toFixed(2)} a second, ${report.model})`
    + `${banked}${rows}${struck}${asked}${kept}${echoed}${stuck}`,
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
  /*
   * NOTHING IS SAID ABOUT A MISSING COVER, and the line that used to be here is
   * gone with the feature that made the sentence true.
   *
   * It read "this book declares NO COVER … Re-run vlm-convert to give it one",
   * which was fair advice while `vlm-convert` cut one out of the scan. It does
   * not any more (`packageVlmEpub` carries the ruling), so every book cast by
   * this program now reaches here without one — and a warning printed on every
   * single run, advising a fix that no longer exists, is worse than silence by
   * both measures a log line is judged on.
   *
   * `report.cover` SURVIVES, because the sweep below still needs it: a cover in
   * an imported book is the user's own and is never dropped for going
   * unmentioned by the prose (src/epub/final.ts).
   */
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
    summary: 'A vision model reads the pages: PDF in, EPUB, plain text or a real-text PDF out.',
    usage: '--pdf <file.pdf> --out <book.epub> [--format <epub|txt|pdf>] [--vlm-model <id>]'
      + ' [--python <path>] [--overlay <file.json>] [--records <file.jsonl>]',
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
      'run that finds that marker reads every page again — because ordering a',
      'conversion that already finished is ordering the work, not a replay of it.',
      'Without the marker the bank is an interrupted run and is resumed exactly as',
      'before.',
      '',
      'NOTHING IS DESTROYED UNTIL ITS REPLACEMENT EXISTS. That re-read writes its',
      'answers to `<bank>.jsonl.pending` and the finished bank is left exactly',
      'where it is; when the run completes, the pending file is renamed over it in',
      'one step. A run that dies leaves the old reading untouched and its own',
      'half-read replacement beside it, which the next run over the same request',
      'picks up where it stopped. There are no `archived-<timestamp>/` hoards of',
      'readings any more: a page costs GPU-minutes and a book costs hours, and the',
      'way that is respected is by never being without a copy, not by keeping',
      'every copy forever.',
      '',
      '--reuse-readings overrides that and rebuilds the book from the banked',
      'answers, AND THAT IS NOW A ROUTE OF ITS OWN. `foundry vlm-read` reads a',
      'book into a bank and writes no document; this command with',
      '--reuse-readings renders that bank into a format, as many times and in as',
      'many formats as somebody wants. Over a complete bank it loads no model and',
      'contacts no server: the pages are rasterised, because the ink of a page',
      'turn is measured in them and figures are cut out of them, and nothing is',
      'inferred. It is also the deliberate free reconvert — iterating on the',
      'parser or the assembler over answers that are already known good. A page',
      'the bank has no answer for is NOT read to fill the gap; it is named, and',
      'every rendering says what is missing. --fresh-readings is',
      'the opposite and the explicit form: re-read whatever the marker says, for a',
      'caller whose own records know the conversion finished (a bank written',
      'before markers existed carries no marker). It also means START THE',
      'REPLACEMENT OVER — a pending re-read that is already there is thrown away',
      'rather than continued, which is the one thing no other flag can say.',
      'Passing both, or either without --readings, is refused rather than',
      'half-obeyed. Whichever of the three happens, the run says which in one',
      'sentence before it renders a page.',
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
      '--overlay APPLIES WHAT A PERSON DECIDED ABOUT THE BLOCKS, out of a file the',
      'run reads and never writes. The readings bank is what the model said; the',
      'overlay is what somebody said about it, and the two are separate files',
      'because a banked answer that has been hand-edited is no longer evidence of',
      'anything. It carries two lists, because there are two kinds of decision.',
      '',
      'AMENDMENTS ARE ABOUT BLOCKS. Each names one by (page, order, part) — the',
      'page, the element\'s place in the model\'s answer, and which piece of it a',
      'markdown split cut out — and strikes it out of the book, renders it as a',
      'different category, or replaces what it says. Struck blocks are gone from',
      'EVERY format, including the facsimile PDF, where a struck Picture is not',
      'cut out of the scan at all. Corrected text goes in where the model\'s text',
      'would have gone, so emphasis, footnote markers, dehyphenation and reflow',
      'all treat it identically — and it never re-splits the block, because the',
      'split is what makes the part numbers every amendment is keyed to. The run',
      'says how many blocks were struck, reclassified and rewritten.',
      '',
      'THE CHAPTERS ARE ABOUT THE BOOK, and the list is definitive. Leave it out',
      'and the chapters are worked out exactly as they always were. Give it and',
      'the book divides at those locations and no others, with those names in the',
      'contents and no others: no heading is promoted, no running head demoted, no',
      'page classified. Removing an entry IS the demotion. An EMPTY list is a',
      'statement too — the book has no divisions and comes out as one section —',
      'and blocks before the first entry are front matter, exactly as in a book',
      'that does not open on a chapter. A chapter\'s opener stays an ordinary',
      'block at the top of its section: what the page prints and what the contents',
      'calls the chapter are two facts, and correcting the first with a text',
      'amendment never touches the second.',
      '',
      'A MALFORMED OVERLAY STOPS THE RUN BEFORE A PAGE RENDERS, and every refusal',
      'names the amendment or the chapter: an unknown category, a page or order',
      'that is not a whole number, a field this program does not read, an',
      'amendment that decides nothing, a chapter with no title, chapters out of',
      'reading order or two at one location. That is the opposite of how',
      '--readings treats a torn last line, and deliberately: a bank is appended to',
      'by a process that can be killed, and an overlay is written whole by',
      'whatever curates the blocks, so anything wrong with it is a bug in the',
      'writer rather than the normal cost of an interrupted run. Use `foundry',
      'vlm-blocks` to get the blocks, their ids and the spine this engine would',
      'build, to write one against. A prose dialect is refused: it names no',
      'blocks to amend.',
      '',
      '--final WRITES THE EDITION RATHER THAN THE WORKING BOOK. Without it the',
      'book that comes out is a workbench: the blocks somebody struck are already',
      'gone, but a struck FOOTNOTE is still in it carrying data-bf-cut="1", and',
      'so are the attributes an editor addresses elements by (data-bf-id,',
      'data-bf-src, data-bf-note). That is what a curator has to see. With it, a',
      'struck note is not written at all, every reference number that pointed at',
      'it keeps the digit the page printed and loses its link, a chapter left with',
      'no notes loses its footnotes section, and none of the four editing',
      'attributes is written. data-bf-page and data-bf-cat STAY, which is',
      '`epub-final`\'s ruling unchanged: page provenance is what makes a scan',
      'citable and it is invisible to a reader.',
      '',
      'It is a flag of the ASSEMBLY, which is why it exists beside `foundry',
      'epub-final` rather than instead of it. That command tidies a book that has',
      'already been built and is what an app runs when it is holding an EPUB.',
      'This flag reaches --format txt, which never becomes an EPUB — the same',
      'documents with their tags stripped — so a note removed from a zip is still',
      'a paragraph of text in the plain-text export. --format pdf accepts the flag',
      'and is unchanged by it: that route forks before notes exist and writes no',
      'data-bf attributes, so its cast and its edition are the same file.',
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
      'NO COVER IS WRITTEN, and that is deliberate. This command used to cut one',
      'out of the first page the book contained and declare it three ways. Which',
      'page a printer meant as the front of a book is not a thing a converter can',
      'know — page 1, the first page not skipped and the first page carrying text',
      'are three different guesses and each is confidently wrong on some scans —',
      'so the book opens on its first chapter, which is never wrong. A cover is a',
      'fact to be stated alongside the title and the author, not inferred here.',
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
      '--format html IS THE WORKBENCH, and it is not an export. It writes the same',
      'book as ONE UNZIPPED PAGE beside its stylesheet and its pictures:',
      '--out book.html gives you book.html, style.css and images/ in that folder.',
      'Every chapter is a <section id> in the one document, every block keeps its',
      'data-bf-* stamps, and nothing is compressed. It exists because an editor',
      'has to be able to SHOW a bank without first zipping it into a book and',
      'unzipping it again: what somebody is doing in Foundry is editing the',
      'contents of a book, not reading one. epub and txt are what an export',
      'compiles to when they are done.',
      '',
      '--format pdf REPRINTS THE BOOK AS REAL TEXT, page for page. Each page of',
      'the output is fresh paper the size of the page it stands for, and every',
      'block the model read is set on it as visible, selectable type at the',
      'position it was printed at. The scan\'s pixels are thrown away: what comes',
      'out is a born-digital PDF that is text at every zoom, copies as',
      'characters, prints at the printer\'s resolution rather than the',
      'scanner\'s, and weighs a fraction of what the scan weighed. The ORIGINAL',
      'file is never touched.',
      '',
      'It is a FACSIMILE and not a typesetting: nothing is reflowed, so the',
      'folio is still at the foot of its page, the running head at its head, and',
      'the book still breaks its pages where the printer broke them. A citation',
      'to page 142 of this file is a citation to page 142 of the book. Nothing',
      'that turns pages into a BOOK runs on this route — no chapters, no',
      'page-turn joins, no dehyphenation, no note markers, no reflow — and the',
      'running heads and page numbers are KEPT, because they are on the page.',
      '',
      'A PICTURE is the one thing that cannot be set as type, so each one is cut',
      'out of the scan and embedded where it was printed. A page with NO reading',
      '— unreadable, or struck out with --skip-pages — keeps a picture of itself',
      'for the same reason, and every one of them is reported by number: a blank',
      'leaf would be a silent claim that the page was empty. It needs a dialect',
      'that answers with geometry (dots-ocr does, and it is the default); a prose',
      'dialect is refused, because there are no positions to place anything at.',
      '',
      'The markup foundry itself added comes back off — a page reading',
      '**Führer** would be wrong about a book that printed Führer — and with it',
      'goes the emphasis, because one embedded face cannot draw bold. A stray',
      'character the font cannot write becomes U+FFFD and is reported by name,',
      'count and page rather than stopping the book or vanishing silently; past',
      'one in a thousand the run refuses instead, because at that scale the font',
      'does not cover the book\'s script. Type that had to be set below 4 pt to',
      'fit the box the model drew is reported too: the words are all there and',
      'too small to read, which is usually a box round the wrong part of a page.',
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
      '',
      '--records CASTS A TRANSFORM\'S WORDS INTO THE BOOK. The file is',
      'translate --records\' product: one row per flowing block, keyed by the',
      'block\'s position in the bank. Each block whose position the file answers',
      'for is written with those words in place of its own, at the one point where',
      'a block\'s text becomes a document — so everything upstream still runs on',
      'the SOURCE text. That order is the design: the page-turn joins, the chapter',
      'proposals, the dehyphenation and the running-head suppression all read the',
      'words the model actually saw, in the language it saw them in, and only then',
      'are the words exchanged. A position the file does not answer for keeps its',
      'source text, so a partial translation renders honestly.',
      '',
      'PROVENANCE STILL NAMES THE SOURCE. data-bf-page, data-bf-cat and',
      'data-bf-src are computed from where a block came from and never from what',
      'it says, so a translated paragraph still points at the scan page a reader',
      'would check it against. dc:language and every xml:lang come from --language,',
      'because a file of sentences does not declare a language and guessing one is',
      'not something this program does. The contents page needs no special',
      'handling at all: nav labels are minted from the heading elements after their',
      'words were substituted, so the chapter and the contents say the same thing',
      'by construction.',
      '',
      'It composes with --final and with --format txt, which is how an export',
      'works: the same reflow, the same curation, a struck note still absent from',
      'the edition, the editing stamps still withheld, and the plain-text route',
      'still the same documents with their tags off. It is refused with',
      '--format pdf and on the prose dialects — a facsimile reprints the page and',
      'a prose dialect has no blocks for a record to be about, and a records file',
      'silently ignored is a book somebody believes is the translation.',
    ].join('\n'),
    options: [
      PDF_IN, OUT_PATH, VLM_FORMAT, VLM_MODEL, VLM_PYTHON, VLM_RENDERS, VLM_LANGUAGE,
      VLM_ENDPOINT, VLM_ENDPOINT_MODEL, VLM_CONCURRENCY, VLM_READINGS,
      VLM_FRESH_READINGS, VLM_REUSE_READINGS, VLM_SKIP_PAGES,
      VLM_OVERLAY, VLM_CHAPTERS, VLM_STRIP_MARKERS, VLM_FINAL, VLM_RECORDS,
    ],
    run: runVlmConvert,
  },
  {
    name: 'vlm-book',
    summary: 'Reflow a readings bank into the book file: hyphens fused, page turns joined, ids minted.',
    usage: '--readings <file.jsonl> | --epub <file.epub>  --out <book.jsonl> [--pdf <file.pdf>] [--language <bcp47>]',
    detail: [
      'THE BANK IS NOT THE BOOK. A bank is one row per PAGE holding the answer the',
      'model gave for it, and it knows nothing about a paragraph: a word the',
      'column broke is two halves with a hyphen between them, and a paragraph the',
      'printer broke across a leaf is two blocks on two pages. Every rule that',
      'fixes those used to run at ASSEMBLY, freshly, on every render of the book,',
      'for the whole life of the project.',
      '',
      'This command runs them ONCE and writes the answer down. The running heads',
      'the model mistagged are dropped, a heading printed on two lines becomes one',
      'heading, the text is dehyphenated against the book\'s own lexicon, print',
      'lines are reflowed back into prose, and a paragraph broken across a leaf',
      'becomes one paragraph. It adds no rule of its own: these are exactly the',
      'passes vlm-convert has always applied, and the product is what they produce.',
      '',
      'EVERY BLOCK GETS A NAME, minted here and never reused: b<page>-<order>, off',
      'the FIRST banked answer the block was made of. Derived rather than counted,',
      'because a sequential number would renumber the whole book the day a better',
      'join merged one more pair — and every correction, chapter marker and',
      'translation record keyed to a name after that point would silently point one',
      'block further back. A merge consumes the SECOND block and leaves the first',
      'exactly where it was, so re-running this changes which names exist and never',
      'what an existing name means.',
      '',
      'PAGE NUMBERS ARE KEPT AND ARE NOT TRUSTED. Every row records the page it',
      'started on and every page it touches, and NOTHING is addressed by either: a',
      'block joined across a leaf did not come from one page, and the number is an',
      'approximation of where it began. The page-for-page record is the facsimile',
      'PDF, which is made from the bank before this runs.',
      '',
      'THE BOX SURVIVES THE MERGE. A joined paragraph keeps the first part\'s',
      'origin and grows by the height of every part after it, with the width taken',
      'as the union — a rectangle that is on no page and is right about the two',
      'things anything asks it, which are how tall a line of this type is and how',
      'wide the text sits. Both are ratios, and both survive the addition.',
      '',
      'NO PDF, NO RASTERISER, NO MODEL, and it takes about as long as reading the',
      'file. A bank written by this version records the render size and the pixel',
      'budget beside every answer, which is the whole frame a box needs; a bank old',
      'enough to lack them is refused by name rather than rasterised again behind',
      'your back.',
      '',
      'THE MARKERS AND THE CHAPTERS COME WITH IT. A superscript in the prose used',
      'to be a shape in a string that only the EPUB writer ever resolved, and it',
      'threw the answer away with the markup; here every note row records where',
      'in the body its number is printed, matched by the number the page set on',
      'both, so deleting a note can take its reference number with it as a',
      'derived fact rather than as a second decision. A marker with no note and a',
      'note with nothing pointing at it are both reported. The header also',
      'carries where the book divides and what each division would be called —',
      'a seed, not a spine, and the first chapter you move takes the list over.',
      '',
      'A page whose answer will not parse is NAMED AND SKIPPED, the same promise',
      'every command over a bank makes: one bad page must not cost the other two',
      'hundred and ninety-nine. A page turn the rule declines to join is reported',
      'too, and that report is the point — it is a seam somebody has to decide, and',
      'this file is the one that keeps the answer.',
      '',
      'VERSION 3 WRITES DOWN WHAT THE BOOK IS MADE OF. Every row now carries its',
      'parts — which banked answer contributed which characters of its finished',
      'text, and the word a broken column made whole — so the seam inside a joined',
      'paragraph is a fact in the file instead of arithmetic every reader repeats.',
      'The declined page turns are pairs of block names rather than page numbers,',
      'because joining a seam means joining two paragraphs and "p13" is neither of',
      'them. NOTHING IS SILENTLY GONE: the page furniture the parse set aside and',
      'the running heads the reflow suppressed are rows too, sitting where the page',
      'had them, marked as shelved and each carrying one sentence of evidence — so',
      'putting one back is an ordinary correction against a name. And the header',
      'says where the book came from: the foundry that wrote it, the language it',
      'was read in, the pages, and the first sixteen hex of a sha-256 over the',
      'bank, which is what lets a later reader know the receipt has not moved',
      'under the names it is holding.',
      '',
      'GIVE IT --pdf AND THE FIGURES ARE CUT ONCE. A Picture block is pixels by',
      'definition and no bank holds any, so the boxes are cropped out of the',
      'archived original into readings/<key>.images/, named after the coordinate',
      'the row was minted at, and every row that has one names its file. Only the',
      'pages carrying a picture are rasterised. Without --pdf nothing is cut, no',
      'row names an image, and the run says so rather than leaving you to notice.',
      '--language is declared and never detected, the same as vlm-convert, and it',
      'defaults to en.',
      '',
      'AN IMPORTED EPUB TAKES THE OTHER DOOR: --epub, instead of --readings, and',
      'the same --out. There is no bank under one and there never will be — a bank',
      'models pages and an EPUB has none, and reading real text back through a',
      'vision model would trade exact data for a guess at it. So the container is',
      'exploded straight into the same book file: the spine is the order and the',
      'names are e-<n> along it, the publisher\'s markup is the category (h1 a',
      'Title, blockquote a Quote, figcaption a Caption, li a List-item, anything',
      'declared epub:type="footnote" a Footnote), the publisher\'s own noteref',
      'anchors mint the reference markers exactly rather than by matching printed',
      'numbers, the nav or the NCX becomes the divisions verbatim, and the figures',
      'are COPIED once beside the book rather than cut, because they are already',
      'files somebody made. Emphasis folds to the same source markers the model',
      'writes. Script, style, iframe, object and embed elements are dropped with',
      'their content at the walk and the count is reported.',
      '',
      'THE ROWS OF SUCH A BOOK CARRY NO PAGE AND NO BOX — page 0, a zero',
      'rectangle, no typography report — because nothing page-shaped exists to',
      'measure and this format has never addressed anything by a page anyway. No',
      'facsimile is made from one. On this route --language OVERRIDES the',
      'package\'s own dc:language rather than defaulting over it, and --pdf has',
      'nothing to cut.',
    ].join('\n'),
    options: [BOOK_READINGS, BOOK_EPUB, BOOK_OUT, BOOK_PDF, BOOK_LANGUAGE, BOOK_PYTHON],
    run: runVlmBook,
  },
  {
    name: 'vlm-compile',
    summary: 'Compile a book file into the finished document: EPUB or plain text. No bank, no model.',
    usage: '--book <book.jsonl> --out <file.epub|.txt> [--images <dir>] [--title <t>] [--author <a>]',
    detail: [
      'THE BOOK FILE IS THE BOOK. vlm-convert compiles a BANK — the model\'s page',
      'answers, put through every rule that turns pages into a book — and that is',
      'the right shape for a book nobody has touched. It is the wrong shape for a',
      'book somebody has EDITED, because the edits are not in the bank: they are',
      'changes recorded against block names, and the document they describe is the',
      'book file with those changes replayed over it.',
      '',
      'So the replay happens once, where the person is looking at it, and what',
      'reaches this command is a book file with the answer already in it — same',
      'format, same names, the struck blocks absent and the words as they were',
      'left. This command replays nothing and decides nothing about the book: what',
      'the rows say is what it writes, and where the header says the book divides',
      'is where it divides. A book file straight out of vlm-book compiles exactly',
      'the same way, which is what makes the two routes one route.',
      '',
      'IT ALWAYS WRITES THE EDITION. vlm-convert has a --final switch because it',
      'writes two books out of one bank: the working copy, which keeps a curator\'s',
      'marks, and the edition, which is what you hand to a library. There is no',
      'working copy here — that is the editor on screen — so the edition\'s rules',
      'are constants: none of the attributes this program addresses elements by are',
      'written. The page and the category stay, because page provenance is what',
      'makes a scan citable and neither is visible to a reader.',
      '',
      'THE REFERENCE NUMBERS ARE LINKED BY POSITION AND NEVER BY SEARCH. Every',
      'note in the book records the exact characters of the body its number is',
      'printed at, resolved when the book was made with the page in front of it —',
      'so the numbers link to their notes and the notes link back, and a number no',
      'note answers to stays the plain superscript the page printed. The same digits',
      'appear five times on a page of a book with fifty notes, and nothing here goes',
      'looking for them.',
      '',
      'GIVE IT --images AND THE FIGURES GO IN. A picture is pixels, cut once into',
      'readings/<key>.images/ when the book was made; every row that has one names',
      'its file, and this copies them into the container. A row naming a figure',
      'that was never cut, or one that is not in the directory it was pointed at,',
      'STOPS THE RUN — a figure missing from the container is a broken image in the',
      'reader, on a book that opened without an error. Plain text carries no',
      'pictures at all and asks for none of it.',
      '',
      'The format is the extension of --out and nothing else: .epub or .txt.',
      '--title and --author land in the package exactly as vlm-convert\'s do; the',
      'language is the reading\'s own, carried by the book file\'s header, and is',
      'declared rather than detected. Same book file and same flags, same bytes.',
    ].join('\n'),
    options: [COMPILE_BOOK, COMPILE_OUT, COMPILE_IMAGES, COMPILE_TITLE, COMPILE_AUTHOR],
    run: runVlmCompile,
  },
  {
    name: 'vlm-read',
    summary: 'Read a PDF into a readings bank with a document VLM. No book is written.',
    usage: '--pdf <file.pdf> --readings <file.jsonl> [--vlm-model <id>] [--vlm-endpoint <url>]'
      + ' [--skip-pages <3,17,19-24>] [--language <bcp47>] [--python <path>]',
    detail: [
      'THE READING IS THE PRODUCT. This command renders every page at 200 dpi,',
      'asks the model for it, and appends the answer to --readings as it lands.',
      'It writes no EPUB, no text file and no PDF, and it never asks which of',
      'those you wanted — that is a separate question, asked later, of a bank',
      'that already exists.',
      '',
      'WHY IT IS ITS OWN COMMAND. Reading a book costs GPU-minutes a page and',
      'hours a book; rendering one out of a finished reading costs seconds and no',
      'GPU at all. Binding them together meant the format had to be chosen before',
      'a page was read, so wanting the same book as text as well as an EPUB meant',
      'either paying for the reading twice or knowing to say --reuse-readings.',
      'Read once; render as often as you like:',
      '',
      '  foundry vlm-read --pdf book.pdf --readings book.jsonl',
      '  foundry vlm-convert --pdf book.pdf --readings book.jsonl --reuse-readings \\',
      '      --format epub --out book.epub',
      '  foundry vlm-convert --pdf book.pdf --readings book.jsonl --reuse-readings \\',
      '      --format txt --out book.txt',
      '',
      'THE SECOND AND THIRD COMMANDS READ NO PAGE. With a complete bank and',
      '--reuse-readings no model is loaded and no server is contacted; the pages',
      'are still rasterised, because a rendering measures the ink of a page turn',
      'and cuts figures out of the scan, but nothing infers anything.',
      '--reuse-readings is not optional there: without it the',
      'book is READ AGAIN — into a pending bank that replaces the completed one',
      'only when the new reading finishes — because ordering a conversion means',
      'ordering the work. That rule is not weakened by this command; it is the',
      'rule that makes a bank safe to keep.',
      '',
      'EVERY ANSWER IS APPENDED AND FSYNCED THE MOMENT IT EXISTS, so a kill costs',
      'the page that was in flight and nothing more, and running this command',
      'again over the same bank resumes it: only the pages that are missing are',
      'read. Each record holds what the model returned in full — the answer, the',
      'token counts, the whole of the server\'s response body where there was one',
      '— together with the render size and the pixel budget the boxes were',
      'measured in, so the bank can be turned back into blocks with no PDF and no',
      'rasteriser at all (see `foundry vlm-blocks`).',
      '',
      'WHEN THE READING FINISHES A COMPLETION MARKER IS WRITTEN beside the bank,',
      'and its outPath is null: this run produced no document, and the marker',
      'says so rather than naming a file that does not exist. Markers written by',
      'a conversion still name their EPUB, and still read.',
      '',
      '--skip-pages 3,17,19-24 leaves pages out: never rasterised, never read,',
      'never in the bank, and every page that stays keeps its true PDF number.',
      '--language is recorded in the marker for whoever renders the book later',
      'and is not used here; a reading has no document to declare a language on.',
      '',
      'A page that came back empty or hit the token cap is NAMED, in the log and',
      'again on the last line, and the reading is kept: every other page cost',
      'real GPU. What never happens is a page quietly guessed at.',
    ].join('\n'),
    options: [
      PDF_IN, VR_READINGS, VLM_MODEL, VLM_PYTHON, VLM_RENDERS, VR_LANGUAGE,
      VLM_ENDPOINT, VLM_ENDPOINT_MODEL, VLM_CONCURRENCY,
      VLM_FRESH_READINGS, VLM_REUSE_READINGS, VLM_SKIP_PAGES,
    ],
    run: runVlmRead,
  },
  {
    name: 'vlm-blocks',
    summary: 'Print the blocks of a banked reading as JSON: page, order, part, category, box, text.',
    usage: '--readings <file.jsonl> [--pdf <file.pdf>] [--vlm-model <id>] [--python <path>]',
    detail: [
      'The blocks a conversion would build its book out of, as data on stdout,',
      'for something with a screen to draw. It reads a --readings bank and parses',
      'each banked answer exactly as vlm-convert does; NO PAGE IS READ FROM A',
      'MODEL, nothing is written, no completion marker is dropped and no bank is',
      'moved, renamed or replaced, so it is safe to run over a bank in the middle',
      'of somebody\'s conversion.',
      '',
      'WHAT IT IS FOR: writing an overlay. Every block comes back with the three',
      'numbers that name it — page, order and part — which are the same three',
      '`vlm-convert --overlay` amendments are keyed to, and with the box it',
      'occupies in the page render, which is what puts an outline round it on a',
      'picture of the page. The blocks and the ids are the ones the renderers see:',
      'this is the same parse, not a second one written to look like it.',
      '',
      'IT ALSO REPORTS THE SPINE THIS ENGINE WOULD BUILD — where a run with no',
      'overlay would divide the book, and what it would call each division, as',
      'locations an overlay\'s "chapters" list can name verbatim. That is so an',
      'editor can open with the engine\'s own answer in front of somebody instead',
      'of an empty list, and so that saving it back unchanged renders the',
      'identical book. It is the same prologue the EPUB route runs — the mistagged',
      'running heads out, the two-line headings joined, the text dehyphenated and',
      'reflowed, the doubled openings folded — because a seed that took a shortcut',
      'past any of those would be wrong on exactly the books those passes exist',
      'for.',
      '',
      'A BOX ONLY MEANS SOMETHING IN A FRAME, and the frame is the render size and',
      'the pixel budget together. A bank written by this version records both',
      'beside every answer, and then this command needs nothing else — no PDF, no',
      'rasteriser, no Python. A bank written before it does not, so --pdf is asked',
      'for and the pages are rasterised again at 200 dpi to measure them; the',
      'renders are thrown away as they are made. Each page in the output says',
      'which of the two it got its geometry from.',
      '',
      'FURNITURE IS INCLUDED. The page header and footer are blocks a person can',
      'strike or reclassify like any other, and a page drawn with holes in it',
      'where the folio was is a page whose outlines do not match the paper. They',
      'arrive in the model\'s own answer order, with the rest.',
      '',
      'THESE ARE THE PAGE\'S BLOCKS, NOT THE BOOK\'S. The passes that turn pages',
      'into a book — suppressing running heads the model mistagged, merging a',
      'heading printed on two lines, rejoining a paragraph across a page turn,',
      'dehyphenating against the book\'s own lexicon — have not run and should',
      'not: they act on the book, and a person curating blocks is looking at the',
      'page.',
      '',
      'A page whose answer cannot be parsed is REPORTED AND SKIPPED, by number,',
      'in an "unreadable" list beside the pages — the same promise vlm-convert',
      'makes, for the same reason: one bad page must not cost somebody the other',
      'two hundred and ninety-nine.',
      '',
      'The output is versioned JSON. Machine-consumed: fields are added, never',
      'renamed, without a version bump.',
    ].join('\n'),
    options: [VB_READINGS, VB_PDF_IN, VLM_MODEL, VLM_PYTHON, VLM_ENDPOINT],
    run: runVlmBlocks,
  },
  {
    name: 'translate',
    summary: 'Translate a foundry EPUB with a local Ollama model: EPUB in, a second EPUB out.',
    usage: '--epub <book.epub> --to <lang> [--from <lang>] [--out <path>|--records <file.jsonl>]'
      + ' [--model <name>] [--instructions <text>] [--bank <file.jsonl>] [--concurrency <n>]',
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
      '--fresh-bank asks for every block again, into `<bank>.pending` beside the',
      'bank, and renames that file over the bank when the book is written. It is',
      'the one instruction the key cannot express — a person wanting the SAME',
      'question asked a second time, because a model is not deterministic. The',
      'answers it is second-guessing are not touched until the new book exists,',
      'and a fresh run that was killed resumes its own pending file rather than',
      'paying twice for the blocks it already re-asked. --fresh-bank without',
      '--bank is refused rather than half-obeyed. There is',
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
      '',
      '--records WRITES RECORDS INSTEAD OF A BOOK, and it is the mode everything',
      'after a translation is built on. Without it the product is a second EPUB:',
      'a file, in which there are no blocks left to decide anything about. With',
      'it the product is one JSONL row per flowing block —',
      '',
      '  {"key":..,"parts":"12:3 13:0","generation":..,"text":"The state was.."}',
      '',
      'where "parts" is the block\'s position in the reading bank, in the same',
      'spelling data-bf-src writes into a cast book and an overlay target uses:',
      'page:order, page:order:part where the markdown pass split an answer,',
      'space-joined where the reflow made one paragraph out of two pages\' blocks,',
      'and page:order#n for one note of a Footnote block. --out is refused, since',
      'no book is written. The book comes later, from',
      'vlm-convert --records <file> --language <tag>, which puts those words into',
      'the same pipeline that already applies the curation, the chapters and the',
      'edition rules — so a translated book is CAST rather than converted, its',
      'contents page comes out translated with no comparison of any kind, and',
      'every decision somebody made about the source reaches it for free.',
      '',
      'THE RECORDS FILE IS ITS OWN BANK, so --bank is refused beside it: an',
      'unchanged block has an unchanged question, its key is already in the file,',
      'and it is never asked again. --fresh-bank still means "ask everything',
      'again", into a pending file that replaces the records only on success. A',
      'row is only appended where it says something new, so re-running over an',
      'unchanged book writes nothing at all — and a position whose newest row a',
      'PERSON wrote is left exactly as they left it, because a machine row',
      'appended on top of a correction would silently revert it.',
      '',
      'IT RE-ASKS THE BOOK ONCE, AND ONLY ONCE. Records mask one stage earlier —',
      'the flowing block\'s own text, where the markup is **emphasis** and',
      'superscript note numbers, rather than rendered XHTML — so the masked source',
      'is a different string and the key is a different key. A book translated to',
      'an EPUB yesterday and to records today is paid for twice, once. Tables are',
      'the one category records cannot carry: a table\'s text is the vision',
      'model\'s own HTML and its cells are not banked blocks, so there is no',
      'position a record about one could be written against. They are left in the',
      'source language, counted, and named on the last line of the run.',
      '',
      '--source-records MAKES A CHAIN. Point it at a parent translation\'s records',
      'and each block is translated from the PARENT\'S answer rather than from the',
      'book\'s own words — German to English to Hungarian, with --from naming the',
      'parent\'s language. A position the parent never answered falls back to the',
      'book. The key hashes the masked parent text, so correcting one English',
      'record re-asks exactly the Hungarian blocks that record feeds and nothing',
      'else. The run says how many of the book\'s blocks the parent actually',
      'answered for, before the GPU is spent, because a chain that chained nothing',
      'is the one failure of this feature nobody can see in the output.',
      '',
      '--book READS THE BOOK ITSELF, and it is the source everything after this',
      'wave uses. An EPUB is a RENDERING of the book: the words have to be',
      'recovered from the markup they were written into, and each block is named',
      'by the data-bf-src stamped on it, which is a coordinate in the reading bank',
      'rather than a name for the paragraph. A book file (docs/BOOK-FILE.md) is one',
      'row per block, its own text, and an ID that is that block\'s name for as',
      'long as the book exists. So a record written on this route is keyed by the',
      'ROW\'S ID — and the derived book file the app materialises from those',
      'records keeps those same ids, which is what makes the source and the',
      'translation two files that agree about what every paragraph is called.',
      '',
      'It requires --records and refuses --epub and --source-records. The first',
      'because this command writes no book file: the derived one is materialised by',
      'the app, from these records and the parent book together. The second because',
      'the two name their blocks differently and a run handed both would silently',
      'pick one. The third because the book file at a position under a translation',
      'IS the parent\'s answers already — a chain needs no second file here.',
      '',
      'A STRUCK ROW IS NOT IN A MATERIALISED BOOK FILE, which is why this route is',
      'the one that can translate a book somebody has edited. The app replays the',
      'ops into the file it hands over, so nothing here has to know what a strike',
      'is, and nothing here consults an overlay to find out.',
    ].join('\n'),
    options: [
      TR_EPUB_IN, TR_BOOK_IN, TR_TO, TR_FROM, TR_OUT, TR_MODEL, TR_OLLAMA, TR_INSTRUCTIONS,
      TR_BANK, TR_FRESH_BANK, TR_CONCURRENCY, TR_KEEP_MODEL,
      TR_RECORDS, TR_SOURCE_RECORDS, TR_GENERATION,
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
      'FOUR ATTRIBUTES ARE STRIPPED AND TWO ARE KEPT. data-bf-cut, data-bf-id,',
      'data-bf-src and data-bf-note mean nothing outside this program and go — the',
      'mark a curator left, the name an editor addresses an element by, the banked',
      'answers its words came from, and which note of its block an aside is.',
      'data-bf-page, data-bf-cat and the pagebreak spans STAY: page provenance is',
      'what makes a scan citable, it is invisible to a reader, and it is what every',
      'later pass reads.',
      '',
      'THE INTEGRITY REPORT IS PRINTED ON EVERY RUN, because "as exact as',
      'possible" is a claim and a claim nobody can check is a claim nobody should',
      'believe. How many reference numbers link to a note; how many stayed a plain',
      '<sup> because the emitter could not match one — that is deliberate, a',
      'marker is matched to a note by page and printed number and no link beats a',
      'wrong one; and how many notes nothing points at.',
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
      'command over, which edits the bytes it was given in place: the document is',
      'parsed by pdf-lib, one dictionary is edited, and pdf-lib writes a NEW file',
      'from its own object model — objects renumbered, the cross-reference table',
      'rebuilt, streams re-emitted, and anything pdf-lib does not model gone.',
      '(vlm-convert --format pdf goes further still and builds a document from',
      'nothing, but it is not asked to preserve one: it reads a scan and writes a',
      'book, and the scan it read is left exactly where it was.)',
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
