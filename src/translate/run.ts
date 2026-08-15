/**
 * translate/run — the run, and the standard a block has to meet to be in the
 * book.
 *
 * WHY THIS COMMAND EXISTS AT THE EPUB, AND NOT AT THE PDF. Measured this week
 * against a 1933 German book: paragraph-sized inputs translate well, and page
 * fragments are catastrophic. A paragraph cut by a page turn is handed to the
 * model as half a sentence, and what comes back is one of three things — the
 * fragment omitted entirely, an invented completion of the clause, or the
 * source language echoed back untouched. All three look like text. None of them
 * is a translation of anything.
 *
 * A foundry EPUB has already solved that, which is the whole reason this
 * command reads one instead of reading pages. `dots-book.ts` rejoins a
 * paragraph that runs over a page turn — by the words when the words say so,
 * and by the ink of the render when they do not — and fuses the word the column
 * broke in half. So the blocks in the EPUB are whole paragraphs, and
 * translating block by block means the fragment failure class does not exist
 * here. **A BLOCK IS NEVER SPLIT.** If a paragraph is too long for the context
 * window that is a fact to report, not a reason to cut it in half and
 * reintroduce the exact defect this design avoids.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A BLOCK IS NEVER SPLIT, AND A BLOCK IS NOT ALWAYS THE WHOLE REQUEST.
 *
 * The unit of a request is a CHUNK, and a chunk is either one standalone block
 * or one container's worth of them — a whole list, a whole quotation, a whole
 * table (`blocks.ts` decides which). The argument for sending a container whole
 * is the same argument as the one for sending a paragraph whole, one level up:
 * an item of a list translated alone has lost the list, and six items each
 * translated in whatever construction the model happened to pick for that item
 * do not read as a list any more. A table cell alone is worse than awkward, it
 * is unanswerable — "Zahl" over years and "Zahl" over member counts are two
 * different English words, and the cell does not carry its column header.
 *
 * WHAT TRAVELS IS WORDS AND POSITION, NEVER MARKUP. The model is not shown
 * XHTML, tag names, attributes or foundry's stamps. A list or a quotation goes
 * as numbered lines and a table goes as pipe-separated rows, and the answer is
 * read back BY POSITION: line 3 is part 3, row 2 cell 1 is that cell. Each part
 * still owns its own source range and is spliced into its own element, so the
 * grid, the list and every attribute in them stay on this side of the wire
 * where a model cannot rearrange them.
 *
 * AND THE COUNT IS THE CONTRACT. An answer with four lines where five were sent
 * is not repaired and not guessed at — the chunk is asked again, and then it
 * FALLS BACK to one request per part, named in the log. A misaligned splice
 * would put the right translation in the wrong element: a book that renders
 * perfectly, reads plausibly, and is wrong in a way no reader can detect. That
 * is the failure this whole file exists to refuse.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY ANSWER IS VERIFIED, AND WHY THE PROMPT IS NOT ENOUGH.
 *
 * Three models were measured on the same book:
 *
 *  - **qwen2.5:7b INVERTS MEANINGS.** It produced sentences whose German said
 *    one thing and whose English said its opposite, fluently, with no signal.
 *    It is disqualified and no flag reaches it.
 *  - **qwen2.5:14b is strong and silently OMITS.** Whole clauses — occasionally
 *    a whole sentence out of a long paragraph — simply not present in the
 *    answer, which otherwise reads perfectly.
 *  - **qwen3:32b is the best of the three and INVENTS.** It smooths: a
 *    connective sentence that is not in the source, a softened rendering of
 *    loaded vocabulary. It is the default because its failures are the ones a
 *    reader can see.
 *
 * The common shape is that every one of these failures produces PLAUSIBLE TEXT.
 * Prompt instructions reduce them and do not eliminate them — compliance is
 * probabilistic, and a rule that holds for 1,900 of 2,000 blocks has failed a
 * hundred times in one book. So instructions are the first line and MECHANICAL
 * VERIFICATION is the one that decides. Every answer is checked before it is
 * allowed into the book:
 *
 *  1. **Not empty.**
 *  2. **Every marker present exactly once, pairs balanced and nested, nothing
 *     invented** (`markers.ts`).
 *  3. **Not an echo** — the answer is not the source handed back.
 *  4. **Not a stub** — under a quarter of the source's length is not a
 *     translation of it, it is an omission, which is 14b's signature failure.
 *  5. **Not a runaway** — past three times the source's length is commentary,
 *     repetition or a model that started answering a different question.
 *
 * A block that fails is retried, at the same fixed temperature, up to twice
 * more. A block that fails three times is REFUSED BY NAME and the job FAILS
 * listing every refusal. There is no partial output. A book that is 99%
 * translated and looks finished is the worst thing this command could produce:
 * nobody can find the missing 1%, and the file will be read, cited and quoted
 * as an English edition.
 *
 * TWO KINDS OF FAILURE, TWO BEHAVIOURS. A model that answers badly is a block
 * problem: it is recorded and the run CONTINUES, so that one job reports every
 * bad block rather than one per run over an evening. A server that stops
 * answering is not — it throws, immediately, and the run ends. Retrying two
 * thousand blocks against a machine that is off would take hours to say
 * "connection refused".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTHING IS PAID FOR TWICE, AND SEVERAL THINGS ARE PAID FOR AT ONCE.
 *
 * `--bank` is an answer file, appended and fsynced as each answer is ACCEPTED,
 * and `bank.ts` holds the whole argument for it — including why it is keyed by
 * the QUESTION (the masked text, the model, the two languages and
 * `--instructions`) and never by the block's position. What this file owes that
 * design is one rule: a chunk with a banked part still travels WHOLE.
 *
 * A chunk exists because an item translated without its list has lost the list
 * and a cell without its column header often cannot be translated at all. That
 * argument does not weaken because three of the four items happen to be on
 * disk: sending the fourth alone would buy back the exact defect chunking was
 * introduced to fix, and it would build a DIFFERENT question — different
 * numbering, different shape rule — whose answer could not be keyed against
 * what was banked. So the whole chunk is sent, THE BANKED PARTS KEEP THEIR
 * BANKED ANSWERS, and only the missing parts are read out of the reply. A chunk
 * is bounded at about a printed page, so the worst case is one page of tokens
 * to answer one item properly, and a chunk whose parts are ALL banked is never
 * sent at all. The bank staying authoritative is also what makes a resume
 * idempotent: however many times a run is killed, the same book comes out.
 *
 * `--concurrency` puts N chunks in flight at once, because Ollama batches
 * concurrent requests and a serial run leaves the GPU idle between them. What
 * that costs is the ORDER of the log, which is fine, and what it must not cost
 * is the honesty of the numbers in it, which is not. So `block N/M` counts
 * blocks FINISHED and `requests done` counts chunks FINISHED — both monotonic,
 * neither a position — because the app draws a progress bar from the first of
 * those and a bar that goes backwards is a bar reporting the wrong quantity.
 *
 * A SERVER ERROR STILL ENDS THE RUN, and with N in flight that needs saying
 * precisely: the FIRST failure in time is the one that surfaces, the workers
 * stop taking new chunks the moment one is recorded, and the run waits for the
 * requests that were already out. It cannot cancel them — nothing in
 * `Transport` can — but leaving them to reject into a dead run is how a later
 * run inherits somebody else's error.
 */
import * as fs from 'node:fs';

import { decodeEntities } from '../epub/xml.js';
import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { bankKey, openTranslationBank, swapPendingBankIntoPlace } from './bank.js';
import { findBlocks, retagLanguage, spliceAll, type BlockGroup, type BlockSite } from './blocks.js';
import { languageRange, navLabels, readFoundryBook, resolveHref, type FoundryBook } from './book.js';
import { flowTextOf } from './flowtext.js';
import { readLanguage, type NamedLanguage } from './languages.js';
import {
  checkMarkers, maskBlock, MarkerError, restoreMarkers, stripMarkers,
  type MarkerCounter, type MaskedBlock,
} from './markers.js';
import { chat, fetchTransport, requireModel, type Transport } from './ollama.js';
import {
  openTranslationRecords, swapPendingRecordsIntoPlace, TranslationRecords,
} from './records.js';
import { maskText, restoreText, roundTrips } from './textmask.js';

/** The run could not produce a book. Names every block that refused. */
export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateError';
  }
}

/** The model the default points at. See this file's header for the measurements. */
export const DEFAULT_TRANSLATE_MODEL = 'qwen3:32b';

/** Ollama's own default, which is where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * How many requests are in flight at once, unless somebody says otherwise.
 *
 * FOUR IS A STARTING POINT AND NOT A MEASUREMENT, and that is said out loud
 * here and in the help because foundry's other concurrency default is not like
 * this one: `DEFAULT_VLM_CONCURRENCY` is twelve because twelve is where the
 * measured knee was on the machine it was built against. Nobody has run that
 * experiment for Ollama on a translation, so this number is chosen to be
 * obviously better than one — a serial run leaves the GPU idle between blocks,
 * and Ollama batches concurrent requests — while being small enough that it
 * cannot be the reason somebody's server started swapping. The right value is a
 * property of somebody else's GPU and their model's size, which is why it is a
 * flag at all.
 */
export const DEFAULT_TRANSLATE_CONCURRENCY = 4;

/** Attempts per block: the first, then two retries. */
const ATTEMPTS = 3;

/** Under this share of the source's length, an answer is an omission. */
const SHORT_RATIO = 0.25;

/** Past this multiple of the source's length, an answer has started inventing. */
const LONG_RATIO = 3;

/**
 * How many blocks the model can fail before the run stops trying.
 *
 * Twenty-five is not twenty-five bad paragraphs. It is the wrong model, a
 * prompt this one will not follow, or a book whose language nobody declared —
 * and the remaining blocks would take hours of GPU to prove the same thing
 * again. The run stops and says so.
 */
const REFUSAL_LIMIT = 25;

/**
 * The most plain text one request may carry, in characters.
 *
 * Two thousand characters is about a printed page, which is the size at which
 * everything measured on this book still holds: it is well inside the 8k
 * context the request asks for, it is well inside the answer budget
 * (`answerBudget` sizes generation from the payload), and it is short enough
 * that a model asked for twelve numbered lines still returns twelve.
 *
 * The bound exists at all because a chunk is ALL-OR-NOTHING on its structure. A
 * forty-item list in one request is one dropped line away from forty items
 * re-asked one at a time, and it is the long payloads where a model starts
 * merging two items into one line. Cutting a long container into runs of
 * consecutive items keeps most of the context — the neighbours an item's
 * grammar is parallel to are usually its neighbours — while keeping the cost of
 * a structural failure to one page rather than one chapter.
 *
 * A single part longer than this is still one chunk. A block is never split
 * (see this file's header); the budget cuts BETWEEN parts and nowhere else.
 */
export const CHUNK_CHARS = 2000;

/**
 * What the model is told about the shape of what it was handed.
 *
 * This is the whole of the structure it ever learns. There is no markup in the
 * payload to infer a shape from, deliberately, so the shape is stated in the
 * prompt and the answer is read back positionally against it.
 */
export type ChunkShape =
  | { kind: 'single' }
  | { kind: 'lines'; count: number; of: 'list' | 'quote' }
  | {
    kind: 'table';
    rows: number;
    /**
     * The table's header row, when this chunk does not contain it because the
     * table was cut by the budget. Context only: it names the columns so a
     * cell's words can be translated as what they are, and the prompt says in
     * as many words that it is not part of the answer.
     */
    header: string | null;
  };

export interface TranslateOptions {
  epubPath: string;
  /**
   * Where the translated BOOK is written. Absent only in records mode, which
   * writes no book — see `recordsPath`.
   */
  outPath?: string;
  /**
   * ── THE TRANSFORM PRODUCES RECORDS, NOT AN EPUB — `--records <file.jsonl>` ──
   *
   * WHAT THE TWO MODES ARE. Without this flag the command does what it has
   * always done: read a stamped EPUB, translate the words inside every stamped
   * element, and write a SECOND BOOK with the same pictures, the same
   * provenance and the same structure. With it, the same blocks are translated
   * and the answers are written as RECORDS — one line per flowing block, keyed
   * by the block's position in the bank (`records.ts` has the format and the
   * argument). No EPUB is produced and `--out` is refused.
   *
   * WHY A SECOND MODE RATHER THAN A BETTER FIRST ONE. The EPUB is a dead end
   * for everything that comes after a translation. Striking a paragraph out of
   * the translated edition, correcting one sentence of it, casting it as plain
   * text, translating it again into a third language — every one of those is a
   * decision about a BLOCK, and in an EPUB there are no blocks left to decide
   * about, only markup that has to be re-parsed and re-spliced. A record is the
   * answer keyed to the block, so the edition is built by materialization
   * (`vlm-convert --records`) with every one of those decisions already in the
   * pipeline that has always applied them.
   *
   * WHAT CHANGES ABOUT THE QUESTION, said out loud because it costs money. The
   * masking moves one stage earlier — `textmask.ts` over the flowing block's
   * own text rather than `markers.ts` over rendered XHTML — so the masked
   * source is a different string and the key is a different key
   * (`bank.ts`, `KEY_FORMATS`). A book translated to an EPUB yesterday and to
   * records today is asked of the model twice. That is ruled and accepted
   * (docs/WORKBENCH.md §10, ruling 1).
   *
   * THE FILE IS ITS OWN BANK. `--bank` is refused beside it, because the
   * records file already answers "has this exact question been asked" — one
   * file, one cache, seeded onto a branch by copying it.
   */
  recordsPath?: string;
  /**
   * ── A CHAIN: TRANSLATE THE TRANSLATION — `--source-records <file.jsonl>` ──
   *
   * The user's own case: *"if they click the english translation and then click
   * translate to hungarian, it translates from english to hungarian, thus
   * creating a chain of translations: german to english to hungarian."*
   *
   * With this, the question about a block is asked of the PARENT'S ANSWER
   * rather than of the book's own words: per position, the source text is the
   * parent records file's newest row for that position, and the book's text is
   * the fallback for a position the parent never answered (a block the parent
   * run refused, a table it skipped, a note it could not name). The key hashes
   * the masked PARENT text, so an edit to one English record re-asks exactly
   * the Hungarian blocks it feeds and nothing else — which is the whole reason
   * a chain is records-native and was not buildable over EPUBs.
   *
   * `--from` is the caller's to state, and it should be the parent's target
   * language: nothing here reads a language out of a records file, because a
   * file of sentences is not a declaration and guessing one would put "German →
   * Hungarian" on a prompt holding English.
   *
   * READ, NEVER WRITTEN. The parent belongs to the parent step.
   */
  sourceRecordsPath?: string;
  /**
   * The app's binding of these records to the reading they were made from,
   * carried into every row and NEVER interpreted — `Overlay.generation`'s
   * contract exactly (`src/vlm/overlay.ts`).
   *
   * The engine has no opinion about the value, never compares two of them and
   * never refuses a run over one. It exists so that a records file can be told
   * apart from one left beside a book that has since been read again, which is
   * a question only the app can answer.
   */
  generation?: string;
  /** Target language tag, already read. */
  to: string;
  /** Source language tag. Absent means the model is told to detect it. */
  from?: string;
  model?: string;
  endpoint?: string;
  /** Free text appended to the system prompt, verbatim. */
  instructions?: string;
  /**
   * JSONL of accepted answers, appended as each one lands — `--bank`. Makes a
   * killed run cost the requests that were in flight and nothing else, and
   * makes a second run over an edited book pay only for what changed.
   * `bank.ts` owns the rule and the key.
   */
  bankPath?: string;
  /**
   * Ask for every block again — `--fresh-bank`.
   *
   * The one instruction the key cannot express. A banked answer is reused
   * because the question is identical; this is a person saying they want the
   * identical question ASKED AGAIN, which a model being non-deterministic makes
   * a reasonable thing to want.
   *
   * IT DOES NOT ARCHIVE AND IT DESTROYS NOTHING UP FRONT: the second opinion is
   * asked into a pending bank that replaces the first only when this run writes
   * its book (`bank.ts`).
   */
  freshBank?: boolean;
  /** Requests in flight at once. Default `DEFAULT_TRANSLATE_CONCURRENCY`. */
  concurrency?: number;
  /** The HTTP boundary. Injected by tests; the real one is `fetchTransport()`. */
  transport?: Transport;
  log: (message: string) => void;
}

export interface TranslateReport {
  /**
   * Translatable BLOCKS — paragraphs, headings, list items, table cells. Still
   * counted the way it always was, so the number still means the same thing
   * about the book, even though several of them now travel in one request.
   */
  blocks: number;
  /**
   * Requests the plan was cut into: one per standalone block, one per list,
   * quotation or table that fitted the budget, and one per run of consecutive
   * parts where it did not. Rejected answers and per-part fallbacks are extra
   * requests on top and are counted in `retries` and named in the log.
   */
  chunks: number;
  documents: number;
  /** Skipped category → how many blocks. */
  skipped: Map<string, number>;
  /**
   * Blocks the model answered this run, and blocks whose accepted answer came
   * out of `--bank` instead. Reported as a PAIR because that is the only form
   * in which either number means anything: a resumed run that says "304 asked"
   * has not said whether it saved anything, and one that says "152 from the
   * bank" has not said what it still cost.
   */
  answered: number;
  fromBank: number;
  /** Answers that failed verification and were asked again. */
  retries: number;
  /** Blocks that carried no prose at all and were kept exactly as written. */
  wordless: number;
  /**
   * Answers kept even though the model gave back fewer markers than it was
   * sent. The words are all there; an <em> or a noteref is not.
   */
  markerNotes: number;
  /**
   * Blocks the model could not translate in `ATTEMPTS` tries, left in the book
   * exactly as it wrote them. Each entry names the block and says why — a count
   * alone would be a number nobody could act on.
   */
  keptUntranslated: string[];
  navRelabelled: number;
  navUnmapped: number;
  /**
   * Records mode only: rows this run appended, and rows it left alone because
   * the newest row for that position was written by a PERSON.
   *
   * The second number is not a curiosity. A re-generate over an unchanged book
   * asks the model nothing and would otherwise re-append the machine's answer
   * on top of somebody's correction — the correction would still be in the file
   * and would no longer be what the book says. Reported so that a run which
   * declined to do that says so.
   */
  recordsWritten: number;
  recordsHumanKept: number;
  seconds: number;
  model: string;
  /** The book, or — in records mode — the records file. What this run made. */
  outPath: string;
}

/**
 * One document's headings, keyed both ways a nav link can reach one: the first
 * heading in the file (what a link with no fragment means) and every heading
 * that carries an id (what a link with one means).
 */
interface DocumentHeadings {
  first: string | null;
  byId: Map<string, string>;
}

/** One block, with everything needed to name it in a refusal. */
interface PendingBlock {
  documentPath: string;
  /** 1-based, over the whole book, which is what the progress line counts. */
  ordinal: number;
  site: BlockSite;
  masked: MaskedBlock;
  /**
   * RECORDS MODE ONLY: where this block lives in the bank, in `data-bf-src`'s
   * own spelling plus `#note` for one note of a Footnote block. Null in the
   * EPUB→EPUB mode, which splices an answer back into the range it came out of
   * and needs no name for it.
   */
  parts: string | null;
  /**
   * Nothing but markup — a heading that is only a pagebreak span, an empty
   * table cell. There is nothing to ask a model, so nothing is asked; but in a
   * group the part still occupies its line or its cell in the payload, because
   * the alignment is positional and a missing line IS a misalignment.
   */
  wordless: boolean;
}

/** One request: what goes out, and which element each piece of the answer belongs to. */
interface Chunk {
  /** How the payload is rendered and how the answer is read back. */
  kind: 'single' | 'lines' | 'table';
  /** What the parts came out of — the word that appears in the log line. */
  of: 'block' | 'list' | 'quote' | 'table';
  documentPath: string;
  /** 1-based over the whole book. Assigned once the plan is complete. */
  ordinal: number;
  parts: PendingBlock[];
  /** `table` only: cells per row, in row order, summing to `parts.length`. */
  rowSizes: number[];
  /** `table` only: the header row's words, when this chunk does not carry it. */
  header: string | null;
}

/**
 * The system prompt.
 *
 * Exported because it is the model's interface and a test asserts its shape —
 * and because a person debugging a bad translation should be able to read the
 * exact words the model was given without instrumenting a run (ARCHITECTURE §4).
 */
/** Which kinds of marker THIS block actually carries — see `systemPrompt`. */
export interface MarkerInventory {
  paired: boolean;
  atomic: boolean;
}

export function systemPrompt(
  from: NamedLanguage | null,
  to: NamedLanguage,
  instructions: string | undefined,
  inventory: MarkerInventory = { paired: true, atomic: true },
  shape: ChunkShape = { kind: 'single' },
): string {
  const source = from === null
    ? 'the language it is written in, which you should determine from the text itself'
    : from.name;
  const one = shape.kind === 'single';
  const lines = [
    `You are a professional literary translator. Translate the text below from ${source} into ${to.name}.`,
    '',
    'RULES:',
    '- Translate faithfully and COMPLETELY. Every sentence of the source must appear in your answer.',
    '- Do not summarise, condense, expand, explain, annotate, or comment. Add nothing that is not in the source.',
    '- Do not soften, sanitise, modernise or euphemise. Render loaded, archaic, technical or offensive'
    + ' vocabulary literally, as written. This is a historical document; its wording is the evidence.',
    /*
     * THE LINE RULE IS THE STRUCTURE RULE. For a single block, a line break in
     * the answer is the model reformatting somebody's paragraph and is refused
     * by saying so. For a chunk of several parts, the line breaks ARE the
     * alignment — one line per item, one line per row — so the rule inverts:
     * keep the count, never merge two, never split one.
     */
    one
      ? '- Keep the source\'s paragraph as one paragraph. Do not add line breaks.'
      : '- Keep each line as one line. Never split a line in two, never join two lines into one,'
      + ' and never reorder them.',
    /*
     * THE TEXT IS ONE BLOCK OF A WHOLE BOOK, and the model is never told what
     * came before it. That matters most at the front, where a scanned book
     * carries things that are not language at all: a library accession number
     * (`HV111$007458S`), a shelf mark, a stamp read badly by the OCR. Asked to
     * translate one of those with no way to say "there is nothing here", qwen3
     * answered a thirteen-character stamp with SIXTEEN THOUSAND characters of
     * invention, three times, at minutes a go.
     *
     * Giving it the honest way out is the upstream fix for that, and it lands
     * in machinery that already exists: an answer identical to its source is
     * written into the book as written. So a stamp echoed three times is KEPT,
     * said out loud and counted — where the same stamp invented over is refused
     * three times and then kept anyway, having burnt ten minutes of GPU to get
     * there. A cell of a table is the same problem in miniature: a column of
     * years has nothing in it to translate, and the model needs to be told that
     * handing one back is right rather than lazy.
     */
    one
      ? '- The text is ONE block from a book, given without its context. Some blocks are not prose at all:'
      + ' a library stamp, an accession number, a shelf mark, a catalogue code, a line of OCR noise from'
      + ' the front matter. If a block has nothing in it to translate, RETURN IT EXACTLY AS GIVEN.'
      + ' Returning it unchanged is a correct answer. Never invent a meaning for it, never explain what'
      + ' you think it might be, and never pad the answer to make it look like a translation.'
      : '- These lines come from one book, given without the rest of its context. Some of them are not'
      + ' prose at all: a number, a date, a shelf mark, a catalogue code, a line of OCR noise. If a line'
      + ' has nothing in it to translate, RETURN IT EXACTLY AS GIVEN. Returning it unchanged is a'
      + ' correct answer. Never invent a meaning for it and never pad it to make it look like a'
      + ' translation.',
    ...shapeRules(shape),
    '',
    ...markerRules(inventory),
    '',
    'OUTPUT ONLY THE TRANSLATION. No preamble, no notes, no explanations, no quotation marks around'
    + ' it, no code fences.',
  ];
  if (instructions !== undefined && instructions.trim().length > 0) {
    lines.push(
      '',
      'ADDITIONAL INSTRUCTIONS from the person requesting this translation. They override the style'
      + ' guidance above; they do not override the marker rules or the output rule:',
      instructions.trim(),
    );
  }
  return lines.join('\n');
}

/**
 * What the model is told about the shape of the thing it was handed.
 *
 * THE SHAPE IS IN THE PROMPT BECAUSE IT IS NOT IN THE PAYLOAD. The payload is
 * words: no tags, no attributes, no stamps, nothing that says "this is a table"
 * except the pipes between the cells. That is the whole point — markup a model
 * cannot see is markup a model cannot damage — but it means the model has to be
 * TOLD what the lines are, in the one place that costs the book nothing if it
 * is ignored.
 *
 * THE COUNT IS SAID AS A NUMBER, twice: how many lines were given and how many
 * are owed back. `parseChunkAnswer` refuses anything else, so this sentence is
 * not the guarantee — it is the instruction that makes the guarantee cheap.
 *
 * A HEADER ROW QUOTED HERE IS CONTEXT AND SAYS SO. When the budget cuts a long
 * table, the chunks after the first no longer carry the row that names the
 * columns, and "Zahl" without its header is not a word anybody can translate.
 * So the header travels in the PROMPT — where the answer parser is not looking,
 * so a model that helpfully returns it too still fails the row count and gets
 * asked again, rather than shifting every cell of the table down by one row.
 */
export function shapeRules(shape: ChunkShape): string[] {
  if (shape.kind === 'single') return [];
  if (shape.kind === 'lines') {
    const what = shape.of === 'list'
      ? 'consecutive items of one list'
      : 'consecutive paragraphs of one quotation';
    return [
      '',
      `SHAPE: You are given ${shape.count} numbered lines, which are ${what}. Return exactly`
      + ` ${shape.count} lines, numbered the same way, in the same order. Translate each line.`
      + ' Return nothing else.',
    ];
  }
  const rules = [
    '',
    `SHAPE: You are given a table of ${shape.rows} row${shape.rows === 1 ? '' : 's'}. Each line is one`
    + ' row and cells are separated by |. Return exactly'
    + ` ${shape.rows} line${shape.rows === 1 ? '' : 's'} with exactly the same number of cells in each.`
    + ' Translate the words in each cell; leave numbers and dates as they are.',
    // The Markdown habit, forbidden here rather than repaired later. A dashed
    // separator row makes the answer one line too long, which is a complaint
    // the reader cannot safely repair: `parseChunkAnswer` will not drop a row
    // of dashes, because a scanned table may genuinely HAVE one and dropping
    // it would put every following row under the wrong header. Cheaper to ask
    // for it not to be written than to spend three attempts and a fallback on
    // the most likely way a model formats a table.
    'Do not write a Markdown separator row of dashes, and do not put a | at the very start or the'
    + ' very end of a line. One line per row, cells separated by | between them and nowhere else.',
  ];
  if (shape.header !== null) {
    rules.push(
      `This table's header row is: ${shape.header}`,
      'That row is given for context only, so you know what each column holds. It is NOT part of what'
      + ' you were asked to translate: do not translate it and do not return it.',
    );
  }
  return rules;
}

/**
 * The marker rules, and ONLY the ones this block needs.
 *
 * Measured on the first real run (Völkischer Beobachter, qwen3:32b): three
 * blocks refused three attempts each for containing ⟦e1⟧…⟦/e1⟧ pairs that were
 * NEVER SENT. Every one of those blocks carried no markers at all — the model
 * had been taught the pair vocabulary by the prompt and then helpfully applied
 * it to text it judged emphatic (one was a bold subdeck). A model cannot invent
 * a notation it was never shown, so a block with no pairs gets no pair rule, a
 * block with no atomics gets no atomic rule, and a block with neither is told
 * the one thing it needs to hear: never write these characters. The inventory
 * is per BLOCK because the failure was per block — the same run's blocks that
 * did carry pairs round-tripped them fine.
 */
export function markerRules(inventory: MarkerInventory): string[] {
  if (!inventory.paired && !inventory.atomic) {
    return [
      'The text contains no ⟦…⟧ markers. Never write the characters ⟦ or ⟧ in your answer, for'
      + ' emphasis or anything else.',
    ];
  }
  const rules = ['MARKERS: the text contains markers written between ⟦ and ⟧.'];
  if (inventory.paired) {
    rules.push(
      '- A pair such as ⟦e1⟧…⟦/e1⟧ wraps a phrase. Translate the phrase and keep the pair around'
      + ' its translation, properly nested.',
    );
  }
  if (inventory.atomic) {
    rules.push(
      '- A single marker such as ⟦m1⟧ stands for something that is not words — a footnote reference,'
      + ' a page marker, a line break. Place it where it belongs in the translated sentence.',
    );
  }
  rules.push(
    '- Reproduce every marker exactly once, spelled exactly as it appears. Never invent, drop,'
    + ' duplicate, renumber or translate a marker'
    + (inventory.paired ? '.' : ', and never write a marker not in the source.'),
  );
  return rules;
}

/**
 * Everything that can be wrong with an answer's CONTENT, said in one sentence.
 *
 * Null means usable. The marker checks live in `markers.ts` and run first,
 * because "the answer dropped ⟦m3⟧" is a more specific complaint than "the
 * answer is short" about the same broken response.
 */
export function checkAnswer(sourceText: string, answer: string): string | null {
  const trimmed = unfence(answer).trim();
  if (trimmed.length === 0) return 'the answer is empty';

  const before = stripMarkers(sourceText);
  const after = stripMarkers(trimmed);
  if (after.length === 0) return 'the answer is nothing but the markers it was given';

  if (after.length < before.length * SHORT_RATIO) {
    return `the answer is ${after.length} characters against the source's ${before.length}`
      + ` — under ${Math.round(SHORT_RATIO * 100)}%, which is a summary rather than a translation`;
  }
  if (after.length > before.length * LONG_RATIO) {
    return `the answer is ${after.length} characters against the source's ${before.length}`
      + ` — over ${LONG_RATIO}×, which is commentary or repetition rather than a translation`;
  }
  return null;
}

/**
 * Take a ``` fence off an answer, rather than refusing the answer for having one.
 *
 * A fence is the model formatting its reply, not a claim about the text: the
 * translation inside it is usually perfect. This used to cost the block three
 * attempts and then the whole run. Peeling it is mechanical, so it is done
 * mechanically — the same reasoning as the edge-marker peel in `markers.ts`.
 *
 * Only a fence that wraps the WHOLE answer is peeled. One in the middle is part
 * of the text (a book about code has code in it) and is left exactly alone.
 */
export function unfence(answer: string): string {
  const match = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(answer);
  return match?.[1] ?? answer;
}

// ── the wire format for a chunk ──────────────────────────────────────────────

/** Splits `1. `, `2) ` and `3: ` off the front of a line and nothing else. */
const NUMBERED = /^(\d+)\s*[.):]\s*([\s\S]*)$/;

/** A line this stage rendered, or a line a model wrote, that begins as a number. */
const LOOKS_NUMBERED = /^\s*\d+\s*[.):]/;

/**
 * The exact bytes one chunk sends.
 *
 * Pure, and exported, for the same reason `systemPrompt` is: this is the model's
 * interface, and somebody debugging a table that came back wrong should be able
 * to see the payload without instrumenting a run (ARCHITECTURE §4).
 */
export function renderChunk(
  kind: 'single' | 'lines' | 'table',
  texts: readonly string[],
  rowSizes: readonly number[],
): string {
  if (kind === 'single') return texts[0] ?? '';
  if (kind === 'lines') return texts.map((text, i) => `${i + 1}. ${text}`).join('\n');
  const rows: string[] = [];
  let at = 0;
  for (const size of rowSizes) {
    rows.push(texts.slice(at, at + size).join(' | '));
    at += size;
  }
  return rows.join('\n');
}

/**
 * Read an answer back into exactly one string per part, or say what is wrong.
 *
 * THIS FUNCTION NEVER GUESSES. Wrong number of lines, a line whose number is not
 * its position, a row with the wrong number of cells: each is a complaint, and
 * the caller asks again and then falls back to one request per part. Every
 * repair that could be attempted here — dropping a line that looks like a
 * preamble, matching lines to parts by length, taking the first N — is a repair
 * that sometimes puts the wrong sentence in the right-looking element. A book
 * where item 4 reads as item 5 renders perfectly, reads plausibly, and cannot be
 * caught by anybody who does not have the German in front of them.
 *
 * ONE TOLERANCE, and it is unambiguous. A model asked for pipe rows will often
 * write them the way Markdown does, with an outer pipe at each end: `| a | b |`
 * splits into FOUR fields where two were wanted, the first and the last empty.
 * Stripping exactly that is reversible — there is no reading of it under which
 * the outer fields were cells — and it turns the single most likely formatting
 * habit from three wasted attempts into a correct answer.
 */
export function parseChunkAnswer(
  kind: 'single' | 'lines' | 'table',
  count: number,
  rowSizes: readonly number[],
  answer: string,
): { parts: string[] } | { complaint: string } {
  if (kind === 'single') return { parts: [answer] };

  const lines = answer.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  if (kind === 'lines') {
    if (lines.length !== count) {
      return {
        complaint: `the answer has ${lines.length} line(s) where the ${count} items sent need`
          + ` ${count} — there is no way to tell which item lost its translation`,
      };
    }
    const parts: string[] = [];
    for (const [i, line] of lines.entries()) {
      const hit = NUMBERED.exec(line);
      if (hit === null) {
        return { complaint: `line ${i + 1} of the answer is not numbered: "${line.slice(0, 50)}"` };
      }
      if (Number(hit[1]) !== i + 1) {
        return {
          complaint: `the answer's line ${i + 1} is numbered ${hit[1]} — the numbers are how each`
            + ' line is matched to the item it belongs to, so they cannot be renumbered',
        };
      }
      parts.push(hit[2]!.trim());
    }
    return { parts };
  }

  if (lines.length !== rowSizes.length) {
    return {
      complaint: `the answer has ${lines.length} row(s) where the table sent ${rowSizes.length}`,
    };
  }
  const parts: string[] = [];
  for (const [i, line] of lines.entries()) {
    const wanted = rowSizes[i]!;
    let cells = line.split('|').map((cell) => cell.trim());
    // The Markdown habit: `| a | b |`. See the header on the one tolerance.
    if (cells.length === wanted + 2 && cells[0] === '' && cells[cells.length - 1] === '') {
      cells = cells.slice(1, -1);
    }
    if (cells.length !== wanted) {
      return {
        complaint: `row ${i + 1} of the answer has ${cells.length} cell(s) where that row has`
          + ` ${wanted} — a row whose cells do not line up would put a translation under the wrong`
          + ' header',
      };
    }
    parts.push(...cells);
  }
  if (parts.length !== count) {
    return { complaint: `the answer holds ${parts.length} cell(s) where the table has ${count}` };
  }
  return { parts };
}

/**
 * Whether these parts can be rendered as lines or rows AT ALL, said by name.
 *
 * Both renderings are made of characters that could occur in the book: a
 * newline ends a line, a `|` ends a cell, and a list item that starts "1. " is
 * indistinguishable from the number this stage would have put there. None of
 * those is common — a foundry block is one paragraph, and `|` is rare in prose
 * — and none of them can be escaped without teaching the model an escape it
 * would then use somewhere else. So the group is not rendered positionally at
 * all: it goes as one request per part, exactly as it did before grouping
 * existed, and the log says which group and why (ARCHITECTURE §8).
 */
export function chunkAmbiguity(
  kind: 'lines' | 'table',
  texts: readonly string[],
  rowSizes: readonly number[],
): string | null {
  for (const [i, text] of texts.entries()) {
    if (text.includes('\n')) {
      return `part ${i + 1} contains a line break, and the line breaks are what separate the parts`;
    }
    if (kind === 'table' && text.includes('|')) {
      return `cell ${i + 1} contains a "|", which is what separates one cell from the next`;
    }
    if (kind === 'lines' && LOOKS_NUMBERED.test(text)) {
      return `item ${i + 1} begins "${text.slice(0, 12).trim()}", which reads as another line number`;
    }
  }
  if (kind === 'table') {
    // A row whose cells are all empty renders as a blank line, and blank lines
    // are dropped when the answer is read back — so the row could not be
    // counted even if the model returned it perfectly.
    let at = 0;
    for (const [i, size] of rowSizes.entries()) {
      const row = texts.slice(at, at + size).join(' | ').trim();
      at += size;
      if (row.length === 0) return `row ${i + 1} is entirely empty, so it has no line to come back on`;
    }
  }
  return null;
}

/** How a block is named in a log line and in a refusal. */
function describe(block: PendingBlock, sourceText: string): string {
  const page = block.site.page === null ? '' : `, page ${block.site.page}`;
  const snippet = stripMarkers(sourceText).slice(0, 60);
  return `${block.documentPath} block ${block.ordinal} (${block.site.category}${page}): "${snippet}…"`;
}

/** Which marker kinds anything in this request carries — see `markerRules`. */
function inventoryOf(parts: readonly PendingBlock[]): MarkerInventory {
  return {
    paired: parts.some((p) => p.masked.markers.some((m) => m.kind === 'paired')),
    atomic: parts.some((p) => p.masked.markers.some((m) => m.kind === 'atomic')),
  };
}

/** What the prompt is told about this request. See `shapeRules`. */
function shapeOf(chunk: Chunk): ChunkShape {
  if (chunk.kind === 'single') return { kind: 'single' };
  if (chunk.kind === 'lines') {
    return { kind: 'lines', count: chunk.parts.length, of: chunk.of === 'quote' ? 'quote' : 'list' };
  }
  return { kind: 'table', rows: chunk.rowSizes.length, header: chunk.header };
}

/**
 * Greedy runs of CONSECUTIVE items under `CHUNK_CHARS`.
 *
 * Consecutive and never reordered, because the whole value of sending a group
 * whole is that an item sits with the items it was written next to: the
 * neighbours whose grammar it is parallel to are its neighbours. An item over
 * budget on its own is its own run — a block is never split (see this file's
 * header), so the budget cuts BETWEEN items and nowhere else.
 */
function cutToBudget<T>(items: readonly T[], weigh: (item: T) => number): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  let carried = 0;
  for (const item of items) {
    const weight = weigh(item);
    if (run.length > 0 && carried + weight > CHUNK_CHARS) {
      runs.push(run);
      run = [];
      carried = 0;
    }
    run.push(item);
    carried += weight;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * One group's parts, cut into the requests that will carry them.
 *
 * A run of ONE part is emitted as a `single` — today's payload, byte for byte,
 * with no numbering and no shape rule. A lone paragraph should go to the model
 * as exactly the string it has always gone as; a one-line numbered list would
 * be a second wire format for the commonest case in the book, bought for
 * nothing. The exception is a table, which stays a table even at one cell,
 * because that is what carries the header row into the prompt.
 */
function planChunks(
  group: BlockGroup,
  parts: PendingBlock[],
  log: (message: string) => void,
): Chunk[] {
  const documentPath = parts[0]!.documentPath;
  const alone = (part: PendingBlock): Chunk => ({
    kind: 'single', of: 'block', documentPath, ordinal: 0, parts: [part], rowSizes: [], header: null,
  });
  if (group.kind === 'single') return [alone(parts[0]!)];

  const kind = group.kind === 'table' ? 'table' : 'lines';
  const trouble = chunkAmbiguity(kind, parts.map((p) => p.masked.text), group.rowSizes);
  if (trouble !== null) {
    log(
      `translate: the ${group.kind} at ${documentPath} block ${parts[0]!.ordinal} is sent one block `
      + `per request rather than whole — ${trouble}`,
    );
    return parts.map(alone);
  }

  const weigh = (part: PendingBlock): number => stripMarkers(part.masked.text).length;

  if (group.kind !== 'table') {
    const of = group.kind;
    return cutToBudget(parts, weigh).map((run) => (run.length === 1
      ? alone(run[0]!)
      : {
        kind: 'lines' as const,
        of,
        documentPath,
        ordinal: 0,
        parts: run,
        rowSizes: [],
        header: null,
      }));
  }

  /*
   * A TABLE IS CUT BETWEEN ROWS AND NEVER INSIDE ONE. Half a row rendered on
   * its own is a line with the wrong number of cells in it before the model has
   * touched anything, and the header that gives those cells their meaning would
   * be describing columns that are not all there.
   */
  const rows: PendingBlock[][] = [];
  let at = 0;
  for (const size of group.rowSizes) {
    rows.push(parts.slice(at, at + size));
    at += size;
  }
  // The first row is the header. Markers are stripped out of it because it is
  // context in the prompt, not payload: showing the model a token it must not
  // reproduce is how a block gets an invented ⟦e1⟧ back (see `markerRules`).
  const header = rows[0]!.map((p) => stripMarkers(p.masked.text)).join(' | ');
  return cutToBudget(rows, (row) => row.reduce((n, p) => n + weigh(p), 0)).map((run, i) => ({
    kind: 'table' as const,
    of: 'table' as const,
    documentPath,
    ordinal: 0,
    parts: run.flat(),
    rowSizes: run.map((row) => row.length),
    header: i === 0 ? null : header,
  }));
}

export async function translateEpub(opts: TranslateOptions): Promise<TranslateReport> {
  const started = Date.now();

  /*
   * The two things about the REQUEST that can be wrong, refused before a byte
   * is read (ARCHITECTURE §8).
   *
   * `--fresh-bank` with no bank is an instruction about a file that was never
   * named, and a flag this program silently drops on the floor is how somebody
   * ends up believing they ordered a fresh translation and got a replay. A
   * concurrency of zero is not "the default" and not "one" — it is a number
   * that would send nothing at all, and guessing which of the two was meant is
   * guessing.
   */
  /*
   * ── WHICH PRODUCT THIS RUN IS FOR, decided here and nowhere else ───────────
   *
   * Every contradiction between the two modes is refused before a byte is read,
   * because each of them is a flag this program would otherwise silently drop:
   * an `--out` that never gets written, a bank that is never consulted, a
   * parent's records that nothing reads.
   */
  const wantsRecords = opts.recordsPath !== undefined;
  if (wantsRecords && opts.outPath !== undefined) {
    throw new TranslateError(
      'recordsPath and outPath were both given. A records run produces records and no book, so '
      + 'the EPUB named by outPath would never be written — and a path this command accepts and '
      + 'does not write to is how somebody ends up looking for a file that was never going to exist.',
    );
  }
  if (!wantsRecords && opts.outPath === undefined) {
    throw new TranslateError(
      'no outPath and no recordsPath: this run has nowhere to put what it produces.',
    );
  }
  if (wantsRecords && opts.bankPath !== undefined) {
    throw new TranslateError(
      'recordsPath and bankPath were both given, and the records file IS the bank — an unchanged '
      + 'block has an unchanged question, its key is already in the records file, and it is never '
      + 'asked again. A second cache beside it would answer nothing the first one does not.',
    );
  }
  if (opts.sourceRecordsPath !== undefined && !wantsRecords) {
    throw new TranslateError(
      'sourceRecordsPath names the parent translation this one is a chain from, and only a records '
      + 'run can consume one: the EPUB→EPUB mode translates the words in the book it was handed.',
    );
  }
  if (opts.generation !== undefined && !wantsRecords) {
    throw new TranslateError(
      'generation is written into records rows, and this run produces a book. Nothing would carry it.',
    );
  }
  if (opts.bankPath === undefined && !wantsRecords && opts.freshBank === true) {
    throw new TranslateError(
      'freshBank was set without a bank file, so there is no bank for it to act on.',
    );
  }
  if (
    opts.concurrency !== undefined
    && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)
  ) {
    throw new TranslateError(
      `concurrency is how many requests may be in flight at once and must be a whole number of at `
      + `least 1, not ${opts.concurrency}.`,
    );
  }
  const concurrency = opts.concurrency ?? DEFAULT_TRANSLATE_CONCURRENCY;

  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
  const transport = opts.transport ?? fetchTransport();
  const to = readLanguage(opts.to, '--to');
  const from = opts.from === undefined ? null : readLanguage(opts.from, '--from');

  const bytes = new Uint8Array(fs.readFileSync(opts.epubPath));
  const book = readFoundryBook(bytes);

  /*
   * The server is proved BEFORE the blocks are masked, and the model with it.
   * Masking two thousand paragraphs is a second of work, so this is not about
   * speed — it is that "no Ollama server answered at http://localhost:11434" is
   * the whole of what a person needs, and burying it under a page of parse
   * progress makes them read the page first.
   */
  await requireModel(transport, endpoint, model);

  /*
   * What this run does about the bank it was pointed at, decided once, done
   * once, and STATED — `bank.ts` owns the rule and the sentence, and the run's
   * only job is to print it before anything is asked. A log that opens by
   * saying whether this run is going to translate the book or resume one is a
   * log somebody can read four hours later.
   *
   * AFTER `requireModel`, and that order no longer decides anything about
   * somebody's answers — it used to. `--fresh-bank` ARCHIVED, so opening the
   * bank before the server was proved could rotate a bank aside and then fail
   * with "no Ollama server answered at http://localhost:11434", accomplishing
   * nothing at all. It now opens a pending file instead and the old bank is
   * untouched until the book lands, which makes that failure cost an empty file.
   * The order stays because the server error is still the first thing a person
   * needs to read, and nothing is gained by moving it.
   */
  const bank = opts.bankPath === undefined
    ? null
    : openTranslationBank({
      bankPath: opts.bankPath,
      freshRequested: opts.freshBank === true,
    });
  if (bank !== null) opts.log(bank.sentence);

  /*
   * The records file, opened on exactly the bank's terms and for exactly its
   * reasons — this file IS the bank in records mode, so `--fresh-bank` means
   * the same thing about it and the pending gamble works the same way.
   */
  const records = opts.recordsPath === undefined
    ? null
    : openTranslationRecords({
      recordsPath: opts.recordsPath,
      freshRequested: opts.freshBank === true,
    });
  if (records !== null) opts.log(records.sentence);

  /*
   * THE PARENT OF A CHAIN, read and never written.
   *
   * Opened through the same reader as this run's own file, so a malformed
   * parent is refused in the same words rather than half-consumed. What is
   * taken from it is one thing: the newest text for a position, which becomes
   * the SOURCE this run translates.
   */
  /*
   * A PARENT THAT IS NOT THERE IS NOT AN EMPTY PARENT. `TranslationRecords.open`
   * answers "nothing recorded" for a path with no file at it — right for this
   * run's own output file, which it is about to create, and wrong for a parent,
   * where it would silently turn a chain into an ordinary translation of the
   * German with the parent's language on the prompt. Hours of GPU, and nothing
   * in the output to tell it from the chain that was ordered.
   */
  if (opts.sourceRecordsPath !== undefined && !fs.existsSync(opts.sourceRecordsPath)) {
    throw new TranslateError(
      `${opts.sourceRecordsPath} was named as the parent of this chain and there is no file there. `
      + 'A missing parent is not an empty one: every block would fall back to the book\'s own words '
      + `and this run would translate the source text as though "${opts.from ?? 'the detected '
        + 'source'}" were what it says.`,
    );
  }
  const sourceRecords = opts.sourceRecordsPath === undefined
    ? null
    : TranslationRecords.open(opts.sourceRecordsPath);
  if (sourceRecords !== null) {
    opts.log(
      `translate: this is a chain — ${sourceRecords.positions} position(s) of `
      + `${opts.sourceRecordsPath!} are the SOURCE, and a block that file does not answer for is `
      + 'translated from the book\'s own words instead.',
    );
  }

  // ── the plan ──────────────────────────────────────────────────────────────

  const skipped = new Map<string, number>();
  const perDocument = new Map<string, { sites: BlockSite[]; htmlTagStart: number; htmlTagEnd: number }>();
  const pending: PendingBlock[] = [];
  const chunks: Chunk[] = [];
  /**
   * Everything that came out of this run still in the source language, named.
   * Filled during the plan (a table this stage cannot take apart) and during
   * the work (a block the model could not do), because both are the same fact
   * about the finished book and a reader has to be told either way.
   */
  const kept: string[] = [];
  /** Blocks whose source text came out of the parent records file. */
  let chained = 0;

  /**
   * WHERE A BLOCK LIVES, in the one spelling this program has for a position.
   *
   * `data-bf-src` plus `#note`, which is `parseTargetKey`'s grammar and
   * `stampSrc`'s output — see `BlockSite.src`. A records run cannot proceed
   * without it: a record with no position is a translation nothing can ever put
   * back, so this throws rather than skipping, and the message says which book
   * would have been needed.
   */
  const positionOf = (site: BlockSite, where: string): string => {
    if (site.src === null || site.src.trim().length === 0) {
      throw new TranslateError(
        `${where} carries a data-bf-cat="${site.category}" block with no data-bf-src on it, so `
        + 'there is no way to say WHICH banked block a record about it would be about. Records are '
        + 'keyed by position, and a translation that cannot be put back is not one. This is either '
        + 'a book stamped by hand (foundry epub-stamp writes categories, not provenance) or an '
        + 'edition (foundry vlm-convert --final withholds the editing stamps deliberately). '
        + 'Translate the CAST book — the working copy — and export the edition afterwards.',
      );
    }
    if (site.category !== 'footnote') return site.src;
    if (site.note === null) {
      throw new TranslateError(
        `${where} carries a footnote with no data-bf-note on it. One banked Footnote answer becomes `
        + 'several notes at emit, so all of them wear the same data-bf-src and the ordinal is the '
        + 'only thing that tells the third from the fourth. Without it a record could only be '
        + 'written about all of them at once. Re-cast the book with this version of foundry.',
      );
    }
    return `${site.src}#${site.note}`;
  };

  for (const document of book.documents) {
    if (!document.stamped) continue;
    const found = findBlocks(document.source, document.path);
    perDocument.set(document.path, {
      sites: found.sites,
      htmlTagStart: found.htmlTagStart,
      htmlTagEnd: found.htmlTagEnd,
    });
    for (const [category, count] of found.skipped) {
      skipped.set(category, (skipped.get(category) ?? 0) + count);
    }
    // Containers `blocks.ts` could not take apart. Said here, before the work,
    // because it changes what the run is about to do and not what it did.
    for (const note of found.notes) opts.log(`translate: ${note}`);

    for (const group of found.groups) {
      /*
       * A TABLE HAS NO RECORD, AND THE REFUSAL IS THE WHOLE GROUP'S.
       *
       * The EPUB→EPUB mode translates a table cell by cell: the cells are
       * elements of the document, each has its own range, and each answer is
       * spliced into the cell it came from. A record cannot work that way. A
       * Table block's TEXT is the vision model's own HTML — the whole grid, as
       * one string, which is what `checkTableHtml` writes into the file and what
       * materialization would substitute — and the cells are not banked blocks,
       * carry no `data-bf-src`, and have no position a record could be keyed to.
       *
       * Translating the grid as one string is the option that exists and is
       * refused: it would hand a model `<tr>`, `<td>` and every attribute in
       * them and ask it not to touch any of it, which is exactly the failure
       * `markers.ts`'s header measured — a table whose columns quietly swapped
       * is worse than a table nobody translated, because it looks fine.
       *
       * So the table is left in the source language, counted where the skipped
       * figures are counted, said at the moment it happens, and put in
       * `keptUntranslated` so it reaches the completion line. Exactly what this
       * run already does for a table it cannot mask, arrived at one step
       * earlier.
       */
      if (records !== null && group.kind === 'table') {
        skipped.set('table', (skipped.get('table') ?? 0) + 1);
        const page = group.parts[0]?.page ?? null;
        const name = `${document.path} table${page === null ? '' : ` on page ${page}`}`
          + ` (${group.parts.length} cells)`;
        const why = 'a table\'s text is the vision model\'s own HTML and its cells are not banked '
          + 'blocks, so there is no position a record about one could be written against';
        kept.push(`${name} — ${why}`);
        opts.log(`translate: ${name} LEFT IN THE SOURCE LANGUAGE — ${why}`);
        continue;
      }

      /*
       * ONE COUNTER FOR THE WHOLE GROUP. Every part of it may arrive in one
       * answer, so `⟦e1⟧` has to mean one thing across all of them — see
       * `MarkerCounter`. A `single` group gets a fresh counter and therefore
       * exactly the numbering it always had.
       */
      const counter: MarkerCounter = { paired: 0, atomic: 0 };
      let masked: MaskedBlock[];
      /** Records mode: one position per part, in the same order. */
      let positions: (string | null)[] = group.parts.map(() => null);
      try {
        if (records === null) {
          masked = group.parts.map(
            (site) => maskBlock(document.source.slice(site.innerStart, site.innerEnd), counter),
          );
        } else {
          positions = group.parts.map((site) => positionOf(site, document.path));
          masked = group.parts.map((site, i) => {
            /*
             * THE QUESTION, IN THREE STEPS AND IN THIS ORDER.
             *
             * The block's own text, recovered from the element the emitter
             * wrote it into (`flowtext.ts`); then, in a chain, the PARENT'S
             * answer for this position in place of it — which is what makes
             * "German → English → Hungarian" ask the model about English words
             * rather than about German ones; then the masking, at text level.
             *
             * The round trip is CHECKED rather than trusted: a block whose
             * masking does not put it back exactly as it was found is refused
             * here, by the same door a table is, because the alternative is a
             * record holding this program's own token characters.
             */
            const own = flowTextOf(document.source.slice(site.innerStart, site.innerEnd));
            const parent = sourceRecords?.textFor(positions[i]!);
            if (parent !== undefined) chained += 1;
            const source = parent ?? own;
            const block = maskText(source, counter);
            const trouble = roundTrips(source, block);
            if (trouble !== null) throw new MarkerError(trouble);
            return block;
          });
        }
      } catch (error) {
        /*
         * A TABLE THIS STAGE CANNOT TAKE APART IS LEFT AS THE BOOK WROTE IT,
         * AND IS NAMED FOR IT.
         *
         * A `<td>` is the vision model's own HTML (`checkTableHtml` in
         * `dots.ts`), not foundry's markup, and `markers.ts` refuses an element
         * it has no rule for — correctly, since passing one through as atomic
         * would silently leave the prose inside it untranslated. But a `<p>`
         * inside a cell must not cost somebody four hours of GPU and a whole
         * book, which is the lesson of the accession number on the flyleaf.
         *
         * So the table drops out of the plan: counted where the skipped figures
         * are counted, said in the log at the moment it happens, and — the part
         * that matters — put in `keptUntranslated`, so it reaches the
         * completion line with the rest of what came out in German. A number
         * with no name behind it would be exactly the undetectable outcome this
         * command exists to refuse (ARCHITECTURE §8).
         */
        /*
         * IN RECORDS MODE THE SAME MERCY COVERS EVERY GROUP, and it has to.
         * The table above is out of the plan before this point, so what reaches
         * here is a block whose markup `flowtext.ts` has no text-level rule for
         * — an element the emitter does not write, an anchor somebody added by
         * hand, a block whose own words contain this stage's token characters.
         * Every one of those is a fact about ONE group, and killing a run of two
         * thousand blocks over it is precisely the trade the flyleaf accession
         * number settled: the group stays in the source language, it is counted,
         * and it is named on the completion line.
         */
        if (!(error instanceof MarkerError)) throw error;
        const page = group.parts[0]?.page ?? null;
        const where = page === null ? '' : ` on page ${page}`;
        if (group.kind === 'table') {
          skipped.set('table', (skipped.get('table') ?? 0) + 1);
          const name = `${document.path} table${where} (${group.parts.length} cells)`;
          kept.push(`${name} — ${error.message}`);
          opts.log(
            `translate: ${name} LEFT IN THE SOURCE LANGUAGE — its cells hold markup this stage has `
            + `no rule for, so its words never travelled: ${error.message}`,
          );
          continue;
        }
        /*
         * IN RECORDS MODE THE SAME MERCY COVERS EVERY GROUP, and it has to. A
         * table is already out of the plan before this point, so what reaches
         * here is a block whose markup `flowtext.ts` has no text-level rule for
         * — an element the emitter does not write, an anchor somebody added by
         * hand, a block whose own words contain this stage's token characters.
         * Every one of those is a fact about ONE group, and killing a run of two
         * thousand blocks over it is precisely the trade the flyleaf accession
         * number settled: the group stays in the source language, it is counted,
         * and it is named on the completion line.
         *
         * The EPUB→EPUB mode still throws, and that is not an inconsistency: in
         * that mode `markers.ts` is masking the emitter's own output and an
         * element it has no rule for means this stage has fallen behind the
         * emitter — a defect in foundry rather than a fact about the book.
         */
        if (records === null) throw error;
        const category = group.parts[0]!.category;
        skipped.set(category, (skipped.get(category) ?? 0) + 1);
        const name = `${document.path} ${category}${where} (${group.parts.length} block(s))`;
        kept.push(`${name} — ${error.message}`);
        opts.log(
          `translate: ${name} LEFT IN THE SOURCE LANGUAGE — its words are markup this stage has no `
          + `text-level rule for, so they never travelled: ${error.message}`,
        );
        continue;
      }

      const parts = group.parts.map((site, i) => {
        const block: PendingBlock = {
          documentPath: document.path,
          ordinal: pending.length + 1,
          site,
          masked: masked[i]!,
          parts: positions[i]!,
          wordless: stripMarkers(masked[i]!.text).length === 0 && masked[i]!.markers.length === 0,
        };
        pending.push(block);
        return block;
      });
      chunks.push(...planChunks(group, parts, opts.log));
    }
  }

  if (pending.length === 0) {
    throw new TranslateError(
      'this book carries foundry\'s stamps but not one of them is a category with words in it — '
      + 'there is nothing here to translate.',
    );
  }

  // Numbered once the whole plan exists, so `chunk 7/41` counts the book and
  // not the document — the same reason block ordinals run across the book.
  for (const [i, chunk] of chunks.entries()) chunk.ordinal = i + 1;

  // "12 picture" read like a typo in the one line a person sees before a run
  // that takes hours. Every skipped category is a single English noun (table,
  // picture, formula), so an `s` is the whole of the grammar needed.
  const skippedNote = skipped.size === 0
    ? ''
    : `; skipping ${[...skipped].map(([c, n]) => `${n} ${c}${n === 1 ? '' : 's'}`).join(', ')}`;
  opts.log(
    `translate: ${pending.length} blocks in ${chunks.length} `
    + `request${chunks.length === 1 ? '' : 's'} across ${perDocument.size} `
    + `document${perDocument.size === 1 ? '' : 's'}${skippedNote}`,
  );
  opts.log(
    `translate: ${model} at ${endpoint}, ${from === null ? 'detected source' : from.name} → ${to.name}`
    + `, up to ${concurrency} request${concurrency === 1 ? '' : 's'} in flight`,
  );
  /*
   * HOW MUCH OF A CHAIN IS ACTUALLY A CHAIN, counted and said before the work.
   *
   * A run pointed at a parent's records that answers for none of this book's
   * positions is not a chain at all — it is a translation of the German with an
   * English `--from` on the prompt, which is the one failure of this feature a
   * person cannot see in the output. The number says so before the GPU is spent.
   */
  if (sourceRecords !== null) {
    opts.log(
      `translate: ${chained} of ${pending.length} block(s) are translated from the parent's answer `
      + `and ${pending.length - chained} from the book's own words`
      + (chained === 0
        ? ' — NOTHING IN THIS BOOK IS ANSWERED BY THAT FILE, so this run is not a chain: check that '
          + 'the parent records were made from this same reading.'
        : '.'),
    );
  }

  // ── the work ──────────────────────────────────────────────────────────────

  const translated = new Map<PendingBlock, string>();
  let retries = 0;
  let wordless = 0;
  /** Answers kept despite giving back fewer markers than they were sent. */
  let markerNotes = 0;
  /** Blocks the model actually answered for this run. */
  let answered = 0;
  /** Blocks whose accepted answer came out of the bank. No GPU was spent. */
  let fromBank = 0;
  /** Records mode: rows appended, and rows a person's own row kept this run off. */
  let recordsWritten = 0;
  let recordsHumanKept = 0;
  /**
   * Blocks this run is FINISHED with: translated, kept for having no words, or
   * refused after every attempt.
   *
   * A COUNT, DELIBERATELY, AND NOT A POSITION. With `--concurrency` the blocks
   * finish out of order, so block 412 can land before block 9 — and the app
   * draws its progress bar from the number in `block N/M` (see
   * `app/electron/engine.ts`). A position there would send the bar backwards
   * several times a minute, reporting a quantity nobody asked about. This is
   * monotonic by construction, whatever order the network answers in.
   */
  let settled = 0;

  /**
   * This block's question, hashed — see `bank.ts` for what is in it.
   *
   * Memoised because it is asked twice for every block that is asked of the
   * model, once to look for an answer and once to bank the one that came back,
   * and a real book is two thousand blocks of it.
   */
  const keys = new Map<PendingBlock, string>();
  const keyOf = (block: PendingBlock): string => {
    const known = keys.get(block);
    if (known !== undefined) return known;
    const key = bankKey({
      text: block.masked.text,
      model,
      to: to.tag,
      from: from === null ? null : from.tag,
      instructions: opts.instructions,
      // The masking stage is part of the question — see `bank.ts`, `KEY_FORMATS`.
      ...(records === null ? {} : { masking: 'text' as const }),
    });
    keys.set(block, key);
    return key;
  };

  /**
   * The answer already on disk for this question, out of whichever file this
   * run is caching in. Null in both means every block is asked.
   */
  const cached = (block: PendingBlock): string | undefined =>
    (records !== null ? records.records.get(keyOf(block)) : bank?.bank.get(keyOf(block)));

  /**
   * An accepted answer, with the book's own markup put back around it.
   *
   * The dropped markers are a NOTE, not a refusal: the words are all there and
   * an <em> is missing, which is a thing a person can see and fix in the HTML
   * editor — where a refused block is a paragraph that never got translated at
   * all. The edges the model never saw go back on mechanically; the start of a
   * block is the start of its translation, in any language.
   *
   * AN ANSWER OUT OF THE BANK GOES THROUGH HERE TOO, and through exactly the
   * same checks. It is not re-verified against `checkAnswer` — it passed that
   * when it was accepted, against the same source text, so the verdict cannot
   * differ — and that has one consequence worth stating: an answer somebody
   * CORRECTED BY HAND in the bank file is written into the book as they wrote
   * it. The file is a record of answers, and a person fixing one is the best
   * outcome this command has.
   */
  const accept = (block: PendingBlock, answer: string, source: 'model' | 'bank'): void => {
    const dropped = checkMarkers(block.masked, answer);
    if (dropped !== null) {
      markerNotes += 1;
      opts.log(`translate: block ${block.ordinal} — ${dropped}; the answer was kept anyway`);
    }
    if (source === 'model') {
      /*
       * BANKED THE MOMENT IT IS ACCEPTED — not at the end of the chunk, not at
       * the end of the document, and certainly not at the end of the run. The
       * whole feature is that a kill costs the requests that were in flight,
       * and every line of delay here is a block somebody pays for twice.
       */
      bank?.bank.append({ key: keyOf(block), source: block.masked.text, answer });
      answered += 1;
    } else {
      fromBank += 1;
    }
    settled += 1;
    if (records === null) {
      translated.set(
        block,
        block.masked.leading + restoreMarkers(block.masked, answer) + block.masked.trailing,
      );
    } else {
      recordRow(block, answer);
    }
    opts.log(`translate: block ${settled}/${pending.length} (${block.documentPath})`);
  };

  /**
   * One accepted answer, written down as a record.
   *
   * THE ROW IS WRITTEN EVEN WHEN THE ANSWER CAME OUT OF THE FILE, because the
   * two identities in it are not the same identity. A key answers "has this
   * question been asked"; a position answers "what does this paragraph say".
   * Two paragraphs with identical words share one key and need two rows, or the
   * second of them silently keeps its source text at materialization.
   *
   * AND IT IS NOT WRITTEN TWICE FOR THE SAME ANSWER. A re-generate over an
   * unchanged book asks the model nothing and must add nothing: the file is
   * appended to for its whole life, so a run that re-stated every position
   * would double the file every time somebody pressed the button.
   *
   * ── A PERSON'S ROW IS NOT OVERWRITTEN BY A MACHINE'S ────────────────────────
   *
   * "Edit transformed text" appends `{…, "author":"user"}` and materialization
   * takes the newest row for a position, so a machine row appended afterwards
   * would silently revert somebody's correction — and it would do it on a run
   * that asked the model nothing, because the key is unchanged and the answer
   * came straight back out of the file. So a position whose newest row is a
   * person's, ANSWERING THE SAME QUESTION, is left exactly as they left it.
   *
   * WHERE THE QUESTION CHANGED, THE MACHINE ROW GOES IN AND THE RUN SAYS SO.
   * A different key means the source block's words changed — somebody corrected
   * the German — and a correction made to the English of a paragraph that no
   * longer exists is not a correction to this one. Keeping it would put a
   * translation of deleted words under text nobody wrote them for. The person's
   * row is still in the file, above the new one, which is the whole reason this
   * format appends.
   */
  const recordRow = (block: PendingBlock, answer: string): void => {
    const key = keyOf(block);
    const parts = block.parts!;
    const text = restoreText(block.masked, answer);
    const newest = records!.records.rowFor(parts);
    if (newest !== undefined && newest.text === text && newest.key === key) return;
    if (newest?.author === 'user' && newest.key === key) {
      recordsHumanKept += 1;
      return;
    }
    if (newest?.author === 'user') {
      opts.log(
        `translate: ${parts} was corrected by hand and its source text has since changed, so this `
        + 'run\'s answer takes over — the correction is still in the file, above it.',
      );
    }
    records!.records.append({
      key,
      parts,
      ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
      text,
    });
    recordsWritten += 1;
  };

  /*
   * A BLOCK THE MODEL CANNOT DO DOES NOT KILL THE RUN.
   *
   * It used to. Every refusal was collected and the whole job threw at the end,
   * on the argument that a book missing a paragraph and looking finished is
   * worse than no book. That argument is right about a PARAGRAPH and was
   * measured wrong about the front matter: block 8 of the Dannenmann scan is
   * `HV111$007458S`, a library accession number stamped on the flyleaf, and an
   * untranslatable stamp on page zero threw away 455 translated blocks and four
   * hours of GPU.
   *
   * So the block is LEFT IN THE SOURCE LANGUAGE — which needs no code at all,
   * because a block with no entry in `translated` is a range the splice below
   * does not touch, and the book keeps exactly what it said. What it needs is to
   * be IMPOSSIBLE TO MISS: the block, its text and the model's complaint go in
   * the log at the moment it happens, they are counted in the report, and the
   * run prints the whole list again at the end.
   *
   * The systemic guard STAYS. Twenty-five is not a run of stamps; it is the
   * wrong model or a prompt this one will not follow, and the remaining blocks
   * would cost hours to prove it again.
   */
  const refuse = (block: PendingBlock, complaint: string): void => {
    kept.push(`${describe(block, block.masked.text)} — ${complaint}`);
    settled += 1;
    opts.log(
      `translate: block ${block.ordinal} LEFT IN THE SOURCE LANGUAGE after ${ATTEMPTS} attempts `
      + `— ${describe(block, block.masked.text)} — ${complaint}`,
    );
    /*
     * A BLOCK THE MODEL REFUSED IS NOT BANKED, and that is the one thing this
     * function owes the bank. A refusal is a fact about a RUN — this model,
     * this evening, three attempts — and not an answer to the question. Banking
     * it would freeze the failure into the file, so a better model tomorrow
     * would never be asked about the paragraph its predecessor could not do.
     */
    if (kept.length >= REFUSAL_LIMIT) {
      throw new TranslateError(
        `${kept.length} blocks could not be translated, which is not a run of bad paragraphs — it `
        + `is the wrong model for this text, or a prompt ${model} will not follow. The `
        /*
         * "The remaining blocks" used to be `pending.length - block.ordinal`,
         * which read the ordinal as a high-water mark — true when the blocks
         * were done in order and false the moment several are in flight. This
         * counts what is actually left: every block with no translation, no
         * refusal and no verdict of any kind yet, including the ones in flight
         * beside this one.
         */
        + `${pending.length - settled} block(s) this run has not finished would cost hours to `
        /*
         * WHAT IS ON DISK IS SAID EXACTLY, and records mode is the case where
         * it matters most. A records run that dies here has written rows for
         * every block it settled — they are real answers, they cost real GPU,
         * and the next run over the same book will not pay for them again — but
         * it has NOT swapped a pending file into place, so a `--fresh-bank` run
         * that failed has left the records it was asked to improve on exactly
         * as it found them.
         */
        + 'prove the same thing. '
        + (records !== null
          ? `NO BOOK IS WRITTEN BY THIS MODE AT ALL, and the ${recordsWritten} record(s) this run `
            + `wrote to ${records.records.filePath} are on disk and will not be paid for again`
            + (records.pendingPath === null
              ? '.'
              : ' — in the pending file, which has NOT taken the place of the records it was asked'
                + ' to replace.')
          : 'NOTHING WAS WRITTEN'
            + (bank === null
              ? '.'
              : `, though the ${answered} answer(s) this run banked in ${bank.bank.filePath} are on `
                + 'disk and will not be paid for again.'))
        + '\n\n'
        + kept.map((r) => `  - ${r}`).join('\n'),
      );
    }
  };

  /**
   * One request for one block, which is what this file did for everything
   * before chunks existed and is still what it falls back to.
   *
   * TWO GUARDS, AND THEY ARE THE OBVIOUS TWO. An answer far shorter than its
   * source is a summary or a dropped half; an answer far longer is a ramble —
   * sixteen thousand characters where the source was a thirteen-character shelf
   * mark. Everything else the model does with a block is WRITTEN AS GIVEN, and
   * that is a deliberate reversal.
   *
   * What used to be here and is gone:
   *
   *  - THE ECHO TEST. It cost three correct translations on the first real run
   *    and needed two witnesses and a word-count floor to be survivable at all.
   *    A model that hands back the source is a model to replace or a prompt to
   *    fix, not a run to kill.
   *  - THE MARKER REFUSAL. A dropped ⟦e1⟧ loses an <em>, not a sentence. It is
   *    now a note in the log and the answer is kept.
   *  - THE CODE FENCE. Peeled mechanically (`unfence`), because a fence is the
   *    model formatting its reply and the translation inside it is fine.
   *
   * The principle: guard the TEXT, which cannot be recovered, and stop guarding
   * the FORM, which can be fixed by hand or ignored.
   */
  const askOne = async (block: PendingBlock): Promise<void> => {
    const sourceText = block.masked.text;
    // The prompt teaches ONLY the marker kinds this block carries — see
    // `markerRules`, and the three refusals that made it exist.
    const system = systemPrompt(from, to, opts.instructions, inventoryOf([block]));
    let accepted: string | null = null;
    let lastComplaint = '';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const answer = unfence(await chat(transport, endpoint, model, system, sourceText)).trim();
      const complaint = checkAnswer(sourceText, answer);
      if (complaint === null) { accepted = answer; break; }
      lastComplaint = complaint;
      retries += 1;
      opts.log(
        `translate: block ${block.ordinal} attempt ${attempt}/${ATTEMPTS} rejected — ${complaint}`,
      );
    }

    if (accepted === null) { refuse(block, lastComplaint); return; }
    accept(block, accepted, 'model');
  };

  /**
   * One request for a whole list, quotation or table, read back by position.
   *
   * THE ATTEMPTS HERE ARE ABOUT STRUCTURE AND NOTHING ELSE. What is retried is
   * an answer that does not come apart into the parts that were sent — the
   * wrong number of lines, a renumbered line, a row with the wrong number of
   * cells. The WORDS are judged afterwards, one part at a time, because a
   * length failure in item 4 is a fact about item 4: re-asking the whole chunk
   * for it would re-translate five items that were already right, which is the
   * cost `ollama.ts`'s header measured and the reason a request used to be one
   * block.
   *
   * Null means three answers in a row could not be read back. The caller then
   * asks for every part on its own — a worse translation, never a wrong one.
   */
  const askGroup = async (chunk: Chunk): Promise<Map<PendingBlock, string> | null> => {
    const payload = renderChunk(chunk.kind, chunk.parts.map((p) => p.masked.text), chunk.rowSizes);
    const system = systemPrompt(
      from, to, opts.instructions, inventoryOf(chunk.parts), shapeOf(chunk),
    );
    let lastComplaint = '';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const answer = unfence(await chat(transport, endpoint, model, system, payload)).trim();
      const parsed = parseChunkAnswer(chunk.kind, chunk.parts.length, chunk.rowSizes, answer);
      if ('parts' in parsed) {
        return new Map(chunk.parts.map((part, i) => [part, parsed.parts[i]!] as const));
      }
      lastComplaint = parsed.complaint;
      retries += 1;
      opts.log(
        `translate: chunk ${chunk.ordinal} attempt ${attempt}/${ATTEMPTS} rejected — ${parsed.complaint}`,
      );
    }

    opts.log(
      `translate: chunk ${chunk.ordinal} (${chunk.of}, ${chunk.parts.length} parts) FELL BACK to one `
      + `request per block after ${ATTEMPTS} attempts — ${lastComplaint}`,
    );
    return null;
  };

  /**
   * One chunk, start to finish.
   *
   * EVERYTHING A CHUNK NEEDS IS IN HERE, because with `--concurrency` several
   * of these run at once and anything left outside would happen in whatever
   * order the network answered in. Nothing in it touches another chunk's parts.
   */
  const runChunk = async (chunk: Chunk): Promise<void> => {
    /*
     * A part with nothing left after the edge peel — a heading that is only a
     * pagebreak span, an empty cell in a table. There are no words, so there is
     * nothing to ask a model, and asking anyway is how a run gets an answer it
     * then has to refuse. It goes into the translation exactly as the book
     * wrote it: edges plus whatever whitespace sat between them IS the whole
     * block, so the reassembly is byte-identical to the source.
     *
     * It is still RENDERED into the payload of a group, with its empty line or
     * its empty cell, because the alignment is positional — a part left out of
     * the payload would shift every part after it by one.
     */
    for (const part of chunk.parts) {
      if (!part.wordless) continue;
      /*
       * IN RECORDS MODE A WORDLESS BLOCK GETS NO ROW AT ALL, and that is the
       * same behaviour said in the other mode's vocabulary. There, the block is
       * written back byte-identical to the source; here, a position with no
       * record keeps its source text at materialization — so writing a row
       * holding the source words would be a longer way of saying nothing, and
       * one that would then have to be told apart from a real translation that
       * happens to read the same.
       */
      if (records === null) {
        translated.set(part, part.masked.leading + part.masked.text + part.masked.trailing);
      }
      wordless += 1;
      settled += 1;
    }
    const askable = chunk.parts.filter((part) => !part.wordless);
    if (askable.length === 0) return;

    /*
     * WHAT THE BANK ALREADY ANSWERS FOR, TAKEN BEFORE ANYTHING IS SENT.
     *
     * A part is looked up by its own question, so a chunk can be PART banked —
     * a run killed inside a list, a book where one item of six was edited, a
     * part refused last time and asked again now. Every hit is accepted here
     * and then left alone: the reply below is read for the missing parts only,
     * which is what keeps a resume idempotent (see this file's header).
     *
     * A chunk with nothing missing is never sent at all. That is the saving.
     */
    const missing: PendingBlock[] = [];
    for (const part of askable) {
      const banked = cached(part);
      if (banked === undefined) { missing.push(part); continue; }
      accept(part, banked, 'bank');
    }
    if (missing.length === 0) return;

    if (chunk.kind === 'single') {
      await askOne(missing[0]!);
      return;
    }

    /*
     * The whole chunk travels, banked parts included. See this file's header:
     * the parts are sent together because an item without its list has lost the
     * list, and dropping the banked ones out of the payload would ask a
     * DIFFERENT question — different count, different numbering, different
     * shape rule — of the parts that are left.
     */
    const answers = await askGroup(chunk);
    if (answers === null) {
      for (const part of missing) await askOne(part);
      return;
    }

    for (const part of missing) {
      const answer = answers.get(part)!;
      const complaint = checkAnswer(part.masked.text, answer);
      if (complaint === null) { accept(part, answer, 'model'); continue; }
      opts.log(
        `translate: block ${part.ordinal} came back inside chunk ${chunk.ordinal} — ${complaint}; `
        + 'asking for it on its own',
      );
      await askOne(part);
    }
  };

  /**
   * The pool: `concurrency` workers pulling chunks off one list.
   *
   * THE COUNT IS OF CHUNKS FINISHED, not of chunks started, for the same reason
   * `settled` is. Out of order, a line printed as a request LEAVES says nothing
   * about how much of the book is done, and two of them can name the same
   * fraction twice.
   *
   * THE FIRST FAILURE IN TIME IS THE ONE THAT SURFACES. `Promise.all` alone
   * would reject on the first rejection and leave the other workers running
   * into a function that has already returned — their requests still in flight,
   * their rejections landing nowhere. So a failure is RECORDED rather than
   * thrown: the workers stop taking new chunks the moment one is recorded, this
   * waits for the requests already out, and the recorded error — the first one,
   * because only the first is ever recorded — is thrown at the end. It cannot
   * cancel a request, since nothing in `Transport` can, but it can refuse to
   * walk away from one.
   */
  let done = 0;
  let nextChunk = 0;
  let firstFailure: unknown = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (firstFailure !== null) return;
      const index = nextChunk;
      nextChunk += 1;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      try {
        await runChunk(chunk);
      } catch (error) {
        if (firstFailure === null) firstFailure = error;
        return;
      }
      done += 1;
      opts.log(
        `translate: ${done}/${chunks.length} requests done — chunk ${chunk.ordinal} `
        + `(${chunk.of}, ${chunk.parts.length} part${chunk.parts.length === 1 ? '' : 's'})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  if (firstFailure !== null) throw firstFailure;

  /*
   * What the bank cost and what it saved, in one line, because a resumed run
   * has to VISIBLY cost less than the run it resumed. "304 asked" on its own
   * does not say whether anything was saved.
   */
  if (bank !== null) {
    opts.log(
      `translate: ${fromBank} of ${pending.length} block(s) came out of the bank and ${answered} `
      + `were asked of ${model}; every answer this run accepted is in ${bank.bank.filePath}.`,
    );
  }
  if (records !== null) {
    opts.log(
      `translate: ${fromBank} of ${pending.length} block(s) were already answered in the records and `
      + `${answered} were asked of ${model}; ${recordsWritten} row(s) were written to `
      + `${records.records.filePath}`
      + (recordsHumanKept === 0
        ? '.'
        : `, and ${recordsHumanKept} position(s) were left exactly as a person corrected them.`),
    );
  }

  /*
   * A TRANSLATION THAT TRANSLATED NOTHING IS NOT ONE.
   *
   * This is what is left of the old all-or-nothing refusal, and it is the part
   * that was always right: if not one block came back from the model in a state
   * worth writing, the output would be the source book with a different
   * `dc:language` on it — a lie about the file, and one that looks exactly like
   * a success. Blocks kept for having no words in them (`wordless`) do not
   * count as work: nothing was asked of the model for those.
   *
   * A BANKED ANSWER COUNTS, and it has to. A resumed run whose bank already
   * holds every block asks the model nothing at all, and that run is the
   * feature working — the book is fully translated and cost no GPU. What this
   * guard is about is a book with no translation in it, not a run with no
   * request in it.
   */
  if (answered + fromBank === 0) {
    throw new TranslateError(
      `not one of ${pending.length} blocks came back as a translation, after ${ATTEMPTS} attempts `
      + `each. NOTHING WAS WRITTEN: this book would have been its own source text with "${to.tag}" `
      + 'stamped on it. The model, the endpoint or the prompt is wrong, not the book.\n\n'
      + kept.map((r) => `  - ${r}`).join('\n'),
    );
  }

  if (kept.length > 0) {
    opts.log(
      `translate: ${kept.length} of ${pending.length} blocks stayed in the source language — `
      + 'they are in the book exactly as it wrote them:',
    );
    for (const one of kept) opts.log(`translate:   - ${one}`);
  }

  // ── the records ───────────────────────────────────────────────────────────

  /*
   * THE PRODUCT ALREADY EXISTS, so all that is left is to make it the file
   * everybody names.
   *
   * There is no assembly here and that is the whole point of the mode: every
   * row was fsynced the moment its answer was accepted, so a run killed at
   * block 400 of 456 leaves 399 usable records rather than nothing. What the
   * swap adds is the `--fresh-bank` guarantee — a second opinion asked into a
   * pending file takes the place of the records it was asked to improve on only
   * once every block has a verdict, and never before.
   */
  if (records !== null) {
    swapPendingRecordsIntoPlace(opts.recordsPath!, records.pendingPath);
    if (records.pendingPath !== null) {
      opts.log(
        `translate: these records were asked into ${records.pendingPath}, so they have taken the `
        + `place of ${opts.recordsPath} — one rename, after every block had a verdict.`,
      );
    }
    return {
      blocks: pending.length,
      chunks: chunks.length,
      documents: perDocument.size,
      skipped,
      answered,
      fromBank,
      retries,
      wordless,
      markerNotes,
      keptUntranslated: kept,
      // A records run relabels no contents page and retags no document: both of
      // those are jobs about a FILE, and this mode produces none. They move to
      // materialization, where the nav is minted from substituted headings and
      // the language comes off `vlm-convert --language` (docs/WORKBENCH.md §10,
      // ruling 4). Reported as zero rather than omitted, because the field means
      // "how many entries this run relabelled" and the honest answer is none.
      navRelabelled: 0,
      navUnmapped: 0,
      recordsWritten,
      recordsHumanKept,
      seconds: (Date.now() - started) / 1000,
      model,
      outPath: opts.recordsPath!,
    };
  }

  // ── the book ──────────────────────────────────────────────────────────────

  const rewritten = new Map<string, string>();
  const headings = new Map<string, DocumentHeadings>();
  const headingsBefore = new Map<string, DocumentHeadings>();

  for (const document of book.documents) {
    const found = perDocument.get(document.path);
    if (found === undefined) continue;
    const edits: { start: number; end: number; text: string }[] = [];
    /*
     * Both readings of every heading — what it said, and what it now says —
     * collected in ONE pass, while the block and its source range are both in
     * hand. The nav needs the pair: the old text is how a label is proved to be
     * a copy of this heading, and the new text is what replaces it.
     */
    const before: DocumentHeadings = { first: null, byId: new Map() };
    const after: DocumentHeadings = { first: null, byId: new Map() };

    for (const block of pending) {
      if (block.documentPath !== document.path) continue;
      const text = translated.get(block);
      if (text === undefined) continue;
      edits.push({ start: block.site.innerStart, end: block.site.innerEnd, text });
      if (!block.site.heading) continue;
      const was = plainOf(document.source.slice(block.site.innerStart, block.site.innerEnd));
      const now = plainOf(text);
      if (before.first === null) { before.first = was; after.first = now; }
      if (block.site.id !== null) { before.byId.set(block.site.id, was); after.byId.set(block.site.id, now); }
    }
    headings.set(document.path, after);
    headingsBefore.set(document.path, before);

    // The `<html>` start tag is outside every block's range by construction —
    // the blocks are in the body — so it joins the same splice rather than
    // needing a second pass over the document.
    const startTag = document.source.slice(found.htmlTagStart, found.htmlTagEnd);
    edits.push({
      start: found.htmlTagStart,
      end: found.htmlTagEnd,
      text: retagLanguage(startTag, to.tag),
    });
    rewritten.set(document.path, spliceAll(document.source, edits));
  }

  /*
   * dc:language becomes the target, and dc:title DOES NOT.
   *
   * The title is the book's name, not a sentence in it: a person looking for
   * this file in a library is looking for the title printed on the German
   * cover, and a shelf listing an invented English name for a book that has no
   * English edition is a shelf that lies about its holdings. The same argument
   * covers dc:creator, the identifier and the modified date. `xml:lang` on
   * <package> is left alone for the same reason but from the other end: it
   * declares the language of the METADATA, and the metadata is still German.
   */
  const range = languageRange(book.opfSource);
  rewritten.set(book.opfPath, spliceAll(book.opfSource, [{ ...range, text: to.tag }]));

  const nav = relabelNav(book, headingsBefore, headings, opts.log);
  if (nav !== null) rewritten.set(book.navPath!, nav.source);

  const entries: ZipEntry[] = book.members.map((member): ZipEntry => {
    const edited = rewritten.get(member.path);
    if (edited !== undefined) return zipText(member.path, edited);
    // Untouched: the bytes, the method and the checksum it arrived with. See
    // the header on `unzip.ts` — this is what keeps the pictures free.
    return {
      path: member.path,
      data: member.raw,
      method: member.method === 8 ? 8 : 0,
      crc: member.crc,
      uncompressedSize: member.uncompressedSize,
    };
  });

  await Bun.write(opts.outPath!, writeZip(entries));

  /*
   * THE BOOK EXISTS, SO THE SECOND OPINION TAKES ITS PLACE.
   *
   * Only a `--fresh-bank` run has a pending file, and for every other run this
   * does nothing. It is here, after the bytes and not before them, for the same
   * reason the readings bank swaps after its EPUB: a run that has not produced
   * the thing it was ordered for has not earned the right to destroy the answers
   * it was asked to improve on.
   */
  if (opts.bankPath !== undefined && bank !== null && bank.pendingPath !== null) {
    swapPendingBankIntoPlace(opts.bankPath, bank.pendingPath);
    opts.log(
      `translate: this book was made from the answers in ${bank.pendingPath}, so they have taken `
      + `the place of ${opts.bankPath} — one rename, after the book landed.`,
    );
  }

  const seconds = (Date.now() - started) / 1000;
  return {
    blocks: pending.length,
    chunks: chunks.length,
    documents: perDocument.size,
    skipped,
    answered,
    fromBank,
    retries,
    wordless,
    markerNotes,
    keptUntranslated: kept,
    navRelabelled: nav?.relabelled ?? 0,
    navUnmapped: nav?.unmapped ?? 0,
    // Zero on this route by construction: records are the other mode's product,
    // and a run that wrote a book wrote no rows.
    recordsWritten: 0,
    recordsHumanKept: 0,
    seconds,
    model,
    outPath: opts.outPath!,
  };
}

/**
 * The table of contents, relabelled from the headings it was made of.
 *
 * A nav label is not text this command may translate on its own. It is a COPY
 * of a heading that lives in a chapter, and translating it separately would ask
 * the model the same question twice and get two answers — a contents page
 * listing "The Coming Struggle" for a chapter headed "The Struggle to Come" is
 * a book that looks like it was assembled from two editions.
 *
 * So a label is replaced only where it can be PROVEN to be a copy: the anchor
 * resolves to a document this run translated, and the label reads exactly as
 * that heading's own text did before translation. Then the translated heading
 * is already the right answer and no second question is asked. Anything else —
 * a hand-edited label, an anchor into a document with no headings, a fragment
 * pointing at something that is not a heading — is LEFT IN THE SOURCE LANGUAGE
 * and counted, because a guess here is a guess that ships in the one part of
 * the book everybody reads first.
 */
function relabelNav(
  book: FoundryBook,
  before: ReadonlyMap<string, DocumentHeadings>,
  after: ReadonlyMap<string, DocumentHeadings>,
  log: (message: string) => void,
): { source: string; relabelled: number; unmapped: number } | null {
  if (book.navPath === null || book.navSource === null) return null;

  const navDir = book.navPath.includes('/') ? book.navPath.slice(0, book.navPath.lastIndexOf('/')) : '';
  const edits: { start: number; end: number; text: string }[] = [];
  let unmapped = 0;
  for (const label of navLabels(book.navSource)) {
    const hash = label.href.indexOf('#');
    const fragment = hash < 0 ? null : label.href.slice(hash + 1);
    const target = resolveHref(navDir, label.href);
    const now = after.get(target);
    const was = before.get(target);
    if (now === undefined || was === undefined) { unmapped += 1; continue; }

    const wasText = fragment === null ? was.first : was.byId.get(fragment) ?? null;
    const nowText = fragment === null ? now.first : now.byId.get(fragment) ?? null;
    if (wasText === null || nowText === null || wasText !== label.text) { unmapped += 1; continue; }
    edits.push({ start: label.innerStart, end: label.innerEnd, text: escapeText(nowText) });
  }

  if (unmapped > 0) {
    log(
      `translate: ${unmapped} contents ${unmapped === 1 ? 'entry' : 'entries'} left in the source `
      + `language — ${unmapped === 1 ? 'its label is not a copy' : 'their labels are not copies'} of a `
      + 'heading this run translated, and inventing one would put a different title in the contents '
      + 'than on the chapter',
    );
  }
  return { source: spliceAll(book.navSource, edits), relabelled: edits.length, unmapped };
}

/**
 * A block's words with its markup removed and its entities decoded.
 *
 * Both sides of the nav comparison go through this and nothing else. A heading
 * reading `Krieg &amp; Frieden` in the chapter and `Krieg &amp; Frieden` in the
 * nav are the same label, and a normaliser applied to only one of them would
 * declare them different and leave a contents page half translated.
 */
function plainOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
