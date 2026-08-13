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
 * How many refused blocks end the run early.
 *
 * Twenty-five failures is not twenty-five bad paragraphs. It is the wrong
 * model, a prompt the model will not follow, or a book whose language nobody
 * declared — and the remaining blocks would take hours of GPU to prove the same
 * thing again. The run stops and says so.
 */
const REFUSAL_LIMIT = 25;

/**
 * The echo test needs a floor, and this is the honest reason for it.
 *
 * A translation that equals its source is normally the model echoing the
 * language it was given, which is 7b's and occasionally 14b's failure. But some
 * blocks are legitimately identical in both languages: a heading that is a
 * proper noun ("Berlin"), a caption that is a date, a one-word section header.
 * Refusing those would fail an entire book over a place name — three wasted
 * retries and then a hard stop on a block whose translation was correct the
 * first time. So the test applies only where identity cannot be a coincidence:
 * a run of real prose. Four words and twenty-four characters is comfortably
 * past any proper noun and comfortably below any sentence.
 */
const ECHO_MIN_CHARS = 24;
const ECHO_MIN_WORDS = 4;

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
  /** Short blocks kept in the source language on the model's persistent word. */
  echoKept: number;
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
 * The longest text an echo may survive on, in words.
 *
 * Eight covers the two measured cases — a five-word company imprint and a
 * seven-word headline of names — with a margin, and stays far under a
 * sentence of prose: the shortest real paragraph in the books this was built
 * against runs well past it. See the echo-acceptance comment in the block
 * loop for why the bound is on LENGTH and not on anything about the words.
 */
const ECHO_KEEP_WORDS = 8;

/** Words, the way `wordCount` in `dots.ts` counts them: runs of non-space. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
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
  const trimmed = answer.trim();
  if (trimmed.length === 0) return 'the answer is empty';
  if (trimmed.includes('```')) {
    return 'the answer is wrapped in a code fence — that is markup the model added to the book';
  }

  const before = stripMarkers(sourceText);
  const after = stripMarkers(trimmed);
  if (after.length === 0) return 'the answer is nothing but the markers it was given';

  if (after.length < before.length * SHORT_RATIO) {
    return `the answer is ${after.length} characters against the source's ${before.length}`
      + ` — under ${Math.round(SHORT_RATIO * 100)}%, which is an omission rather than a translation`;
  }
  if (after.length > before.length * LONG_RATIO) {
    return `the answer is ${after.length} characters against the source's ${before.length}`
      + ` — over ${LONG_RATIO}×, which is commentary or repetition rather than a translation`;
  }

  const words = before.split(/\s+/).filter((w) => w.length > 0).length;
  if (before.length >= ECHO_MIN_CHARS && words >= ECHO_MIN_WORDS && after === before) {
    return 'the answer is the source, unchanged — the model echoed the text instead of translating it';
  }
  return null;
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

  const skippedNote = skipped.size === 0
    ? ''
    : `; skipping ${[...skipped].map(([c, n]) => `${n} ${c}`).join(', ')}`;
  opts.log(
    `translate: ${pending.length} blocks across ${perDocument.size} `
    + `document${perDocument.size === 1 ? '' : 's'}${skippedNote}`,
  );
  opts.log(
    `translate: ${model} at ${endpoint}, ${from === null ? 'detected source' : from.name} → ${to.name}`,
  );

  // ── the work ──────────────────────────────────────────────────────────────

  const translated = new Map<PendingBlock, string>();
  const refusals: string[] = [];
  let retries = 0;
  let wordless = 0;
  let echoKept = 0;

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
    let accepted: string | null = null;
    let lastComplaint = '';
    let echoes = 0;
    let lastAnswer = '';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const answer = (await chat(transport, endpoint, model, system, sourceText)).trim();
      const complaint = checkMarkers(block.masked, answer) ?? checkAnswer(sourceText, answer);
      if (complaint === null) { accepted = answer; break; }
      if (complaint.includes('echoed')) echoes += 1;
      lastAnswer = answer;
      lastComplaint = complaint;
      retries += 1;
      opts.log(
        `translate: block ${block.ordinal} attempt ${attempt}/${ATTEMPTS} rejected — ${complaint}`,
      );
    }

    /*
     * THE ECHO THAT IS RIGHT. "Henkel & Cie. A.-G., Düsseldorf" does not
     * translate — its English is itself — and on the first real run the echo
     * check refused it three times for being correct, along with a headline
     * that is six proper names and the word "an". The check cannot be dropped:
     * a model that hands back a German paragraph unchanged is the laziness it
     * exists to catch. So an echo is accepted on two witnesses together:
     *
     *  - PERSISTENCE. The model must echo on every attempt. One echo is a
     *    lapse; the same answer three times, asked three times, is a claim
     *    that this text does not change.
     *  - BREVITY. Short display text only. A name-plate, an imprint, a
     *    headline of names is where translation-invariant text lives; a
     *    paragraph that comes back unchanged three times is a broken run,
     *    whatever the model insists.
     *
     * The text's SPELLING was tried as the second witness and it fails in
     * both directions on German alone: "Kirchenwahlen 1932" has no lowercase
     * word and translates, the Hermans headline has one and does not. There
     * is no mechanical test for "translatable" — but there is a mechanical
     * bound on the harm: the worst wrong acceptance leaves one short heading
     * in the source language, SAID OUT LOUD below and counted in the report,
     * while the wrong refusal it replaces killed a 96-block job for being
     * right twice.
     */
    const short = wordCount(stripMarkers(sourceText)) <= ECHO_KEEP_WORDS;
    if (accepted === null && echoes === ATTEMPTS && short) {
      accepted = lastAnswer;
      echoKept += 1;
      opts.log(
        `translate: block ${block.ordinal} KEPT IN THE SOURCE LANGUAGE — the model answered `
        + `${ATTEMPTS} times that "${stripMarkers(sourceText).slice(0, 40)}" does not change`,
      );
    }

    if (accepted === null) {
      refusals.push(`${describe(block, sourceText)} — ${lastComplaint}`);
      opts.log(`translate: REFUSED ${describe(block, sourceText)}`);
      if (refusals.length >= REFUSAL_LIMIT) {
        throw new TranslateError(
          `${refusals.length} blocks refused, which is not a run of bad paragraphs — it is the wrong `
          + `model for this text, or a prompt ${model} will not follow. The remaining `
          + `${pending.length - block.ordinal} blocks would cost hours to prove the same thing.\n\n`
          + refusals.map((r) => `  - ${r}`).join('\n'),
        );
      }
      continue;
    }

    // The edges the model never saw go back on mechanically — the start of a
    // block is the start of its translation, in any language.
    translated.set(
      block,
      block.masked.leading + restoreMarkers(block.masked, accepted) + block.masked.trailing,
    );
    opts.log(`translate: block ${block.ordinal}/${pending.length} (${block.documentPath})`);
  }

  if (refusals.length > 0) {
    throw new TranslateError(
      `${refusals.length} of ${pending.length} blocks could not be translated to a standard worth `
      + `writing into a book, after ${ATTEMPTS} attempts each. NOTHING WAS WRITTEN: a book that is `
      + 'missing a paragraph and looks finished is worse than no book. Pin the terminology with '
      + '--instructions, or try another --model.\n\n'
      + refusals.map((r) => `  - ${r}`).join('\n'),
    );
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
    echoKept,
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
