/**
 * commands — the command surface.
 *
 * Every command here is a STUB. It parses its arguments, prints what the stage
 * will do, and exits 1 with "not implemented". Nothing in this repo has been
 * migrated from BookForgeApp yet; see docs/MIGRATION.md for what moves where.
 *
 * The stubs exist now, before the code, because the command surface is the
 * contract BookForge will call across. It is easier to argue about the shape of
 * `foundry boxes <blocks.json>` while it is forty lines of stub than after
 * three call sites depend on it.
 */

import { formatOptions, parseArgs, UsageError, type OptionSpec } from './args.js';

/**
 * Flags every command accepts.
 *
 * All three are OVERRIDES of normal resolution, and none of them turns a
 * missing thing into a working thing: a `--tesseract` that points at the wrong
 * version is still an error, because the models are trained on one specific
 * Tesseract's segmentation (see docs/ARCHITECTURE.md, "Pinned Tesseract").
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
  { name: 'help', short: 'h', type: 'boolean', describe: 'Show help for this command.' },
];

export interface Command {
  name: string;
  /** One line, shown in the top-level command list. */
  summary: string;
  /** Argument shape for the usage line, e.g. `<input.pdf> -o <output.epub>`. */
  usage: string;
  /** Full prose shown by `foundry <cmd> --help`: what this stage will do. */
  detail: string;
  /** Options beyond the global ones. */
  options?: readonly OptionSpec[];
  /** Positional arguments, for the help block. */
  positionals?: readonly { name: string; describe: string }[];
}

const OUT_EPUB: OptionSpec = {
  name: 'out',
  short: 'o',
  type: 'string',
  placeholder: '<output.epub>',
  describe: 'Where to write the EPUB.',
};

const OUT_JSON: OptionSpec = {
  name: 'out',
  short: 'o',
  type: 'string',
  placeholder: '<blocks.json>',
  describe: 'Where to write the blocks JSON. Default: stdout.',
};

export const COMMANDS: readonly Command[] = [
  {
    name: 'convert',
    summary: 'Full pipeline: a scanned PDF in, a clean EPUB out.',
    usage: '<input.pdf> -o <output.epub>',
    detail: [
      'Runs the whole foundry in order and writes an EPUB:',
      '',
      '  scan       pinned Tesseract at 200 dpi segments each page into blocks',
      '  boxes      the boxes adapter labels every block (body, chapter, running',
      '             head, footnote, caption, discard, …)',
      '  ocr        the ocr adapter repairs Tesseract errors line by line, under',
      '             the edit contract — the model emits edits, an applier applies',
      '             them, and an edit that does not match the source is rejected',
      '  footnotes  the footnotes adapter strips inline reference markers so TTS',
      '             does not read them aloud',
      '  export     labels drive the XHTML: what is narrated, what is dropped,',
      '             and where the chapter splits go',
      '',
      'The base model loads once and the three adapters are hot-swapped per',
      'request, so this is one resident model, not three.',
      '',
      'Each stage is also a standalone command taking and returning the same',
      'blocks JSON, so a pipeline can be stopped, inspected, edited, and resumed.',
    ].join('\n'),
    options: [OUT_EPUB],
    positionals: [{ name: 'input.pdf', describe: 'The scanned PDF to recast.' }],
  },
  {
    name: 'scan',
    summary: 'Segment a PDF into text blocks with the pinned Tesseract.',
    usage: '<input.pdf> [-o <blocks.json>]',
    detail: [
      'Renders each page at 200 dpi and runs the PINNED Tesseract over it,',
      'emitting one record per text block: page number, bounding box, the raw',
      'recognized text, and the per-word confidences.',
      '',
      'The dpi and the Tesseract version are not settings. Every model in this',
      'repo was trained on the output of one specific Tesseract at 200 dpi, and',
      'segmentation moves with both — a different build or a different',
      'resolution hands the models an input distribution they never saw, and the',
      'damage shows up as a bad model rather than a bad scan.',
      '',
      'This is the only stage that touches the PDF. Everything downstream reads',
      'and writes the blocks JSON.',
    ].join('\n'),
    options: [OUT_JSON],
    positionals: [{ name: 'input.pdf', describe: 'The scanned PDF to segment.' }],
  },
  {
    name: 'boxes',
    summary: 'Label each block with what it is (adapter: foundry-boxes).',
    usage: '<blocks.json> [-o <blocks.json>]',
    detail: [
      'Runs the boxes adapter over every block on every page and writes a',
      'category onto each one: body, chapter opening, subheading, running head,',
      'page number, footnote, caption, table fragment, title, discard.',
      '',
      'The category is what makes an EPUB out of a scan. It decides what gets',
      'narrated, what is thrown away (running heads, page numbers, scanner',
      'artifacts), and where the chapter boundaries fall.',
      '',
      'Blocks are encoded a page at a time, because a running head is only',
      'recognizable as one relative to the rest of the page. The prompt is built',
      'by our own encoder and sent VERBATIM to llama-server /completion; the',
      'model id carries the version, and the version picks both the prompt format',
      'and the legal class list.',
    ].join('\n'),
    options: [OUT_JSON],
    positionals: [{ name: 'blocks.json', describe: 'Output of `foundry scan`.' }],
  },
  {
    name: 'ocr',
    summary: 'Repair Tesseract OCR errors (adapter: foundry-ocr).',
    usage: '<blocks.json> [-o <blocks.json>]',
    detail: [
      'Runs the ocr adapter line by line over the recognized text and repairs',
      'what Tesseract got wrong: broken ligatures, rn/m, l/1/I, split and fused',
      'words, dropped diacritics.',
      '',
      'The model does not emit corrected prose. It emits EDITS — `before → after`',
      'pairs — and a deterministic applier applies them, rejecting any `before`',
      'it cannot find verbatim in the line. That contract is what keeps a small',
      'model from rewriting the author: a hallucinated edit fails to match and is',
      'dropped, instead of silently replacing a sentence.',
      '',
      'Hyphenation across a line break is a JOIN, never a completion: the two',
      'halves are rejoined as they appear, and the model is never asked to guess',
      'the rest of a word.',
    ].join('\n'),
    options: [OUT_JSON],
    positionals: [{ name: 'blocks.json', describe: 'Output of `foundry scan` or `foundry boxes`.' }],
  },
  {
    name: 'footnotes',
    summary: 'Strip inline footnote reference markers (adapter: foundry-footnotes).',
    usage: '<blocks.json> [-o <blocks.json>]',
    detail: [
      'Finds the footnote reference markers left inline in the body text — †, ‡,',
      '*, superscript numbers, and the OCR debris they turn into — and deletes',
      'them, so a narrator does not read "the treaty collapsed 47" out loud.',
      '',
      'The model emits `<anchor+marker> → <anchor>` lines, or the single word',
      '`none`. The applier enforces a SUBSEQUENCE GUARD: `after` must be',
      'reachable from `before` by deleting characters only. A model that tries to',
      'reword, resupply a missing letter, or fix punctuation on the way past is',
      'rejected by construction, not by review.',
      '',
      'The number that matters here is the false-fire rate on blocks that have no',
      'markers at all — a model that edits clean prose damages a book, and a',
      'model that never fires scores a perfect false-fire while being useless.',
      'Read the two together.',
    ].join('\n'),
    options: [OUT_JSON],
    positionals: [{ name: 'blocks.json', describe: 'Blocks carrying corrected text.' }],
  },
  {
    name: 'export',
    summary: 'Build an EPUB from labelled, corrected blocks.',
    usage: '<blocks.json> -o <output.epub>',
    detail: [
      'Turns labelled blocks into XHTML and packages an EPUB. The categories do',
      'the work: chapter openings become chapter boundaries and headings, body',
      'blocks become paragraphs, running heads and page numbers are dropped,',
      'footnotes are collected out of the reading flow, captions are marked so a',
      'narrator can be told to skip them.',
      '',
      'Paragraph reconstruction is prosody-driven: a paragraph ends where the',
      'text says it ends, not where the page did, so a sentence broken across a',
      'page turn is one sentence again.',
    ].join('\n'),
    options: [OUT_EPUB],
    positionals: [{ name: 'blocks.json', describe: 'Blocks after boxes/ocr/footnotes.' }],
  },
  {
    name: 'models',
    summary: 'Fetch and verify the base model and adapters.',
    usage: '<pull|list>',
    detail: [
      'foundry models list',
      '    Show the catalog: the base model and the three adapters, each with its',
      '    id, version, size, sha256, and whether it is present on disk and',
      '    verified.',
      '',
      'foundry models pull',
      '    Download whatever is missing from HuggingFace (owner: owenmorgan) into',
      '    the models directory, verifying sha256 on arrival. A file whose hash',
      '    does not match is deleted and named, never used.',
      '',
      'Weights live on HuggingFace; only code lives in git. Nothing here is',
      'bundled into the binary — the distribution is three binaries plus the',
      'weights they pull on first run.',
    ].join('\n'),
    positionals: [{ name: 'pull|list', describe: 'Which model action to run.' }],
  },
];

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
 * Run a stub.
 *
 * Parses so that argument errors are real errors today, then reports that the
 * stage is not implemented and exits 1. It does NOT write an empty output file
 * or return success — a stub that exits 0 is a fallback, and a caller wiring up
 * a pipeline against it would find out much later.
 */
export function runStub(cmd: Command, argv: readonly string[]): never {
  const specs = [...(cmd.options ?? []), ...GLOBAL_OPTIONS];
  const parsed = parseArgs(argv, specs);

  if (parsed.options.help) {
    process.stdout.write(commandHelp(cmd) + '\n');
    process.exit(0);
  }

  const required = cmd.positionals?.length ?? 0;
  if (parsed.positional.length < required) {
    throw new UsageError(
      `${cmd.name} needs ${required} argument${required === 1 ? '' : 's'}: ` +
        `${cmd.positionals!.map((p) => p.name).join(' ')}`,
    );
  }

  process.stderr.write(
    `foundry ${cmd.name}: not implemented\n\n` +
      `This repository is a scaffold. No stage has been migrated from BookForgeApp\n` +
      `yet — see docs/MIGRATION.md for what moves here and from where.\n\n` +
      `What this command will do:\n\n` +
      cmd.detail
        .split('\n')
        .map((l) => (l ? `  ${l}` : ''))
        .join('\n') +
      '\n',
  );
  process.exit(1);
}
