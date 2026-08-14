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
 */
import * as fs from 'node:fs';

import { decodeEntities } from '../epub/xml.js';
import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { findBlocks, retagLanguage, spliceAll, type BlockGroup, type BlockSite } from './blocks.js';
import { languageRange, navLabels, readFoundryBook, resolveHref, type FoundryBook } from './book.js';
import { readLanguage, type NamedLanguage } from './languages.js';
import {
  checkMarkers, maskBlock, MarkerError, restoreMarkers, stripMarkers,
  type MarkerCounter, type MaskedBlock,
} from './markers.js';
import { chat, fetchTransport, requireModel, type Transport } from './ollama.js';

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
  outPath: string;
  /** Target language tag, already read. */
  to: string;
  /** Source language tag. Absent means the model is told to detect it. */
  from?: string;
  model?: string;
  endpoint?: string;
  /** Free text appended to the system prompt, verbatim. */
  instructions?: string;
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
  seconds: number;
  model: string;
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
       * ONE COUNTER FOR THE WHOLE GROUP. Every part of it may arrive in one
       * answer, so `⟦e1⟧` has to mean one thing across all of them — see
       * `MarkerCounter`. A `single` group gets a fresh counter and therefore
       * exactly the numbering it always had.
       */
      const counter: MarkerCounter = { paired: 0, atomic: 0 };
      let masked: MaskedBlock[];
      try {
        masked = group.parts.map(
          (site) => maskBlock(document.source.slice(site.innerStart, site.innerEnd), counter),
        );
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
        if (group.kind !== 'table' || !(error instanceof MarkerError)) throw error;
        skipped.set('table', (skipped.get('table') ?? 0) + 1);
        const page = group.parts[0]?.page ?? null;
        const name = `${document.path} table${page === null ? '' : ` on page ${page}`}`
          + ` (${group.parts.length} cells)`;
        kept.push(`${name} — ${error.message}`);
        opts.log(
          `translate: ${name} LEFT IN THE SOURCE LANGUAGE — its cells hold markup this stage has no `
          + `rule for, so its words never travelled: ${error.message}`,
        );
        continue;
      }

      const parts = group.parts.map((site, i) => {
        const block: PendingBlock = {
          documentPath: document.path,
          ordinal: pending.length + 1,
          site,
          masked: masked[i]!,
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
    `translate: ${model} at ${endpoint}, ${from === null ? 'detected source' : from.name} → ${to.name}`,
  );

  // ── the work ──────────────────────────────────────────────────────────────

  const translated = new Map<PendingBlock, string>();
  let retries = 0;
  let wordless = 0;
  /** Answers kept despite giving back fewer markers than they were sent. */
  let markerNotes = 0;
  /** Blocks the model actually answered for. Zero of these is a failed run. */
  let answered = 0;

  /**
   * An accepted answer, with the book's own markup put back around it.
   *
   * The dropped markers are a NOTE, not a refusal: the words are all there and
   * an <em> is missing, which is a thing a person can see and fix in the HTML
   * editor — where a refused block is a paragraph that never got translated at
   * all. The edges the model never saw go back on mechanically; the start of a
   * block is the start of its translation, in any language.
   */
  const accept = (block: PendingBlock, answer: string): void => {
    const dropped = checkMarkers(block.masked, answer);
    if (dropped !== null) {
      markerNotes += 1;
      opts.log(`translate: block ${block.ordinal} — ${dropped}; the answer was kept anyway`);
    }
    answered += 1;
    translated.set(
      block,
      block.masked.leading + restoreMarkers(block.masked, answer) + block.masked.trailing,
    );
    opts.log(`translate: block ${block.ordinal}/${pending.length} (${block.documentPath})`);
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
    opts.log(
      `translate: block ${block.ordinal} LEFT IN THE SOURCE LANGUAGE after ${ATTEMPTS} attempts `
      + `— ${describe(block, block.masked.text)} — ${complaint}`,
    );
    if (kept.length >= REFUSAL_LIMIT) {
      throw new TranslateError(
        `${kept.length} blocks could not be translated, which is not a run of bad paragraphs — it `
        + `is the wrong model for this text, or a prompt ${model} will not follow. The remaining `
        + `${pending.length - block.ordinal} blocks would cost hours to prove the same thing. `
        + 'NOTHING WAS WRITTEN.\n\n'
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
    accept(block, accepted);
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

  for (const chunk of chunks) {
    opts.log(
      `translate: chunk ${chunk.ordinal}/${chunks.length} (${chunk.of}, ${chunk.parts.length} `
      + `part${chunk.parts.length === 1 ? '' : 's'})`,
    );

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
      translated.set(part, part.masked.leading + part.masked.text + part.masked.trailing);
      wordless += 1;
    }
    const askable = chunk.parts.filter((part) => !part.wordless);
    if (askable.length === 0) continue;

    if (chunk.kind === 'single') {
      await askOne(chunk.parts[0]!);
      continue;
    }

    const answers = await askGroup(chunk);
    if (answers === null) {
      for (const part of askable) await askOne(part);
      continue;
    }

    for (const part of askable) {
      const answer = answers.get(part)!;
      const complaint = checkAnswer(part.masked.text, answer);
      if (complaint === null) { accept(part, answer); continue; }
      opts.log(
        `translate: block ${part.ordinal} came back inside chunk ${chunk.ordinal} — ${complaint}; `
        + 'asking for it on its own',
      );
      await askOne(part);
    }
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
   */
  if (answered === 0) {
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

  await Bun.write(opts.outPath, writeZip(entries));

  const seconds = (Date.now() - started) / 1000;
  return {
    blocks: pending.length,
    chunks: chunks.length,
    documents: perDocument.size,
    skipped,
    retries,
    wordless,
    markerNotes,
    keptUntranslated: kept,
    navRelabelled: nav?.relabelled ?? 0,
    navUnmapped: nav?.unmapped ?? 0,
    seconds,
    model,
    outPath: opts.outPath,
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
