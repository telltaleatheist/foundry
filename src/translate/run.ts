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
import { findBlocks, retagLanguage, spliceAll, type BlockSite } from './blocks.js';
import { languageRange, navLabels, readFoundryBook, resolveHref, type FoundryBook } from './book.js';
import { readLanguage, type NamedLanguage } from './languages.js';
import { checkMarkers, maskBlock, restoreMarkers, stripMarkers, type MaskedBlock } from './markers.js';
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
  blocks: number;
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
): string {
  const source = from === null
    ? 'the language it is written in, which you should determine from the text itself'
    : from.name;
  const lines = [
    `You are a professional literary translator. Translate the text below from ${source} into ${to.name}.`,
    '',
    'RULES:',
    '- Translate faithfully and COMPLETELY. Every sentence of the source must appear in your answer.',
    '- Do not summarise, condense, expand, explain, annotate, or comment. Add nothing that is not in the source.',
    '- Do not soften, sanitise, modernise or euphemise. Render loaded, archaic, technical or offensive'
    + ' vocabulary literally, as written. This is a historical document; its wording is the evidence.',
    '- Keep the source\'s paragraph as one paragraph. Do not add line breaks.',
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
     * accepted when the model persists in it and the block is short (see
     * ECHO_KEEP_WORDS). So a stamp echoed three times is KEPT, said out loud
     * and counted — where the same stamp invented over is refused three times
     * and then kept anyway, having burnt ten minutes of GPU to get there.
     */
    '- The text is ONE block from a book, given without its context. Some blocks are not prose at all:'
    + ' a library stamp, an accession number, a shelf mark, a catalogue code, a line of OCR noise from'
    + ' the front matter. If a block has nothing in it to translate, RETURN IT EXACTLY AS GIVEN.'
    + ' Returning it unchanged is a correct answer. Never invent a meaning for it, never explain what'
    + ' you think it might be, and never pad the answer to make it look like a translation.',
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

/** How a block is named in a log line and in a refusal. */
function describe(block: PendingBlock, sourceText: string): string {
  const page = block.site.page === null ? '' : `, page ${block.site.page}`;
  const snippet = stripMarkers(sourceText).slice(0, 60);
  return `${block.documentPath} block ${block.ordinal} (${block.site.category}${page}): "${snippet}…"`;
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
    for (const site of found.sites) {
      pending.push({
        documentPath: document.path,
        ordinal: pending.length + 1,
        site,
        masked: maskBlock(document.source.slice(site.innerStart, site.innerEnd)),
      });
    }
  }

  if (pending.length === 0) {
    throw new TranslateError(
      'this book carries foundry\'s stamps but not one of them is a category with words in it — '
      + 'there is nothing here to translate.',
    );
  }

  // "12 picture" read like a typo in the one line a person sees before a run
  // that takes hours. Every skipped category is a single English noun (table,
  // picture, formula), so an `s` is the whole of the grammar needed.
  const skippedNote = skipped.size === 0
    ? ''
    : `; skipping ${[...skipped].map(([c, n]) => `${n} ${c}${n === 1 ? '' : 's'}`).join(', ')}`;
  opts.log(
    `translate: ${pending.length} blocks across ${perDocument.size} `
    + `document${perDocument.size === 1 ? '' : 's'}${skippedNote}`,
  );
  opts.log(
    `translate: ${model} at ${endpoint}, ${from === null ? 'detected source' : from.name} → ${to.name}`,
  );

  // ── the work ──────────────────────────────────────────────────────────────

  const translated = new Map<PendingBlock, string>();
  /** Blocks the model could not do, left in the source language and named. */
  const kept: string[] = [];
  let retries = 0;
  let wordless = 0;
  /** Answers kept despite giving back fewer markers than they were sent. */
  let markerNotes = 0;
  /** Blocks the model actually answered for. Zero of these is a failed run. */
  let answered = 0;

  for (const block of pending) {
    const sourceText = block.masked.text;

    /*
     * A block with nothing left after the edge peel — a heading that is only a
     * pagebreak span, a paragraph that is only a <br/>. There are no words, so
     * there is nothing to ask a model, and asking anyway is how a run gets an
     * answer it then has to refuse. The block goes into the translation
     * exactly as the book wrote it.
     */
    if (stripMarkers(sourceText).length === 0 && block.masked.markers.length === 0) {
      // Edges plus whatever whitespace sat between them IS the whole block, so
      // the reassembly below is byte-identical to the source.
      translated.set(block, block.masked.leading + sourceText + block.masked.trailing);
      wordless += 1;
      continue;
    }

    // The prompt teaches ONLY the marker kinds this block carries — see
    // `markerRules`, and the three refusals that made it exist.
    const system = systemPrompt(from, to, opts.instructions, {
      paired: block.masked.markers.some((m) => m.kind === 'paired'),
      atomic: block.masked.markers.some((m) => m.kind === 'atomic'),
    });
    /*
     * TWO GUARDS, AND THEY ARE THE OBVIOUS TWO.
     *
     * An answer far shorter than its source is a summary or a dropped half; an
     * answer far longer is a ramble — sixteen thousand characters where the
     * source was a thirteen-character shelf mark. Everything else the model does
     * with a block is WRITTEN AS GIVEN, and that is a deliberate reversal.
     *
     * What used to be here and is gone:
     *
     *  - THE ECHO TEST. It cost three correct translations on the first real
     *    run and needed two witnesses and a word-count floor to be survivable
     *    at all. A model that hands back the source is a model to replace or a
     *    prompt to fix, not a run to kill.
     *  - THE MARKER REFUSAL. A dropped ⟦e1⟧ loses an <em>, not a sentence. It
     *    is now a note in the log and the answer is kept.
     *  - THE CODE FENCE. Peeled mechanically (`unfence`), because a fence is
     *    the model formatting its reply and the translation inside it is fine.
     *
     * The principle: guard the TEXT, which cannot be recovered, and stop
     * guarding the FORM, which can be fixed by hand or ignored.
     */
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

    /*
     * The markers the model did not give back. A NOTE, not a refusal: the words
     * are all there and an <em> is missing, which is a thing a person can see
     * and fix in the HTML editor — where a refused block is a paragraph that
     * never got translated at all.
     */
    if (accepted !== null) {
      const dropped = checkMarkers(block.masked, accepted);
      if (dropped !== null) {
        markerNotes += 1;
        opts.log(`translate: block ${block.ordinal} — ${dropped}; the answer was kept anyway`);
      }
    }

    /*
     * A BLOCK THE MODEL CANNOT DO DOES NOT KILL THE RUN.
     *
     * It used to. Every refusal was collected and the whole job threw at the
     * end, on the argument that a book missing a paragraph and looking finished
     * is worse than no book. That argument is right about a PARAGRAPH and was
     * measured wrong about the front matter: block 8 of the Dannenmann scan is
     * `HV111$007458S`, a library accession number stamped on the flyleaf, and
     * an untranslatable stamp on page zero threw away 455 translated blocks and
     * four hours of GPU.
     *
     * So the block is LEFT IN THE SOURCE LANGUAGE — which needs no code at all,
     * because a block with no entry in `translated` is a range the splice below
     * does not touch, and the book keeps exactly what it said. What it needs is
     * to be IMPOSSIBLE TO MISS: the block, its text and the model's complaint go
     * in the log at the moment it happens, they are counted in the report, and
     * the run prints the whole list again at the end. That is the same treatment
     * `wordless` and `echoKept` already get, for the same reason — text that
     * comes out of a translation still in the source language is a fact about
     * the book, and the person who ordered it has to be told which blocks.
     *
     * The systemic guard STAYS. Twenty-five is not a run of stamps; it is the
     * wrong model or a prompt this one will not follow, and the remaining blocks
     * would cost hours to prove it again.
     */
    if (accepted === null) {
      kept.push(`${describe(block, sourceText)} — ${lastComplaint}`);
      opts.log(
        `translate: block ${block.ordinal} LEFT IN THE SOURCE LANGUAGE after ${ATTEMPTS} attempts `
        + `— ${describe(block, sourceText)} — ${lastComplaint}`,
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
      continue;
    }
    answered += 1;

    // The edges the model never saw go back on mechanically — the start of a
    // block is the start of its translation, in any language.
    translated.set(
      block,
      block.masked.leading + restoreMarkers(block.masked, accepted) + block.masked.trailing,
    );
    opts.log(`translate: block ${block.ordinal}/${pending.length} (${block.documentPath})`);
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
