#!/usr/bin/env bun
/**
 * foundry — recast a broken scan into a clean book.
 *
 * A type foundry casts worn type into fresh type. This one takes a badly
 * scanned PDF and casts it back into a readable EPUB: pinned Tesseract finds
 * the blocks, three LoRA adapters on one shared Qwen3-4B base decide what each
 * block IS, repair what the OCR got wrong, and strip the footnote markers, and
 * the labels drive the EPUB.
 *
 * Entry point. Dispatch only — every stage lives in its own module, and this
 * file's job is to turn argv into exactly one of them and to make failure loud.
 *
 * NO FALLBACKS. An unknown command, a missing file, a missing binary and a
 * missing weight are each an error that names the missing thing and exits
 * nonzero. Nothing here degrades quietly into doing less than it was asked.
 */

import { UsageError } from './args.js';
import { COMMANDS, commandHelp, findCommand, formatOptionsBlock, runStub } from './commands.js';

const VERSION = '0.0.0-scaffold';

function topLevelHelp(): string {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'foundry — recast poorly scanned PDFs into clean EPUBs.',
    '',
    'Usage:',
    '  foundry <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(pad)}  ${c.summary}`),
    '',
    'Pipeline:',
    '  PDF → scan → boxes → ocr → footnotes → export → EPUB',
    '',
    '  `convert` runs all of it. The individual commands take and return the',
    '  same blocks JSON, so a run can be stopped, inspected, edited and resumed.',
    '',
    'Global options:',
    formatOptionsBlock(),
    '',
    'Run `foundry <command> --help` for what a stage does.',
    `Version ${VERSION} — a scaffold. Every command is a stub; see docs/MIGRATION.md.`,
  ].join('\n');
}

function main(argv: readonly string[]): void {
  if (argv.length === 0) {
    process.stdout.write(topLevelHelp() + '\n');
    process.exit(0);
  }

  const first = argv[0];

  if (first === '--help' || first === '-h' || first === 'help') {
    const target = argv[1] ? findCommand(argv[1]) : undefined;
    if (argv[1] && !target) throw new UsageError(`unknown command "${argv[1]}"`);
    process.stdout.write((target ? commandHelp(target) : topLevelHelp()) + '\n');
    process.exit(0);
  }

  if (first === '--version' || first === '-v' || first === 'version') {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }

  if (first.startsWith('-')) {
    throw new UsageError(`expected a command, got the option "${first}"`);
  }

  const cmd = findCommand(first);
  if (!cmd) {
    throw new UsageError(
      `unknown command "${first}". Known commands: ${COMMANDS.map((c) => c.name).join(', ')}`,
    );
  }

  runStub(cmd, argv.slice(1));
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`foundry: ${err.message}\n\nRun \`foundry --help\`.\n`);
    process.exit(2);
  }
  throw err;
}
