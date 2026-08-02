#!/usr/bin/env bun
/**
 * foundry — recast a broken scan into a clean book.
 *
 * A type foundry casts worn type into fresh type. This one takes a badly
 * scanned page and casts it back into a readable EPUB: pinned Tesseract finds
 * the lines, three LoRA adapters on one shared Qwen3-4B base decide what each
 * block IS, repair what the OCR got wrong, and strip the footnote markers, and
 * the labels drive the EPUB.
 *
 * Entry point. Dispatch only — every stage lives in its own module, and this
 * file's job is to turn argv into exactly one of them and to make failure loud.
 *
 * NO FALLBACKS. An unknown command, a missing file, a missing binary and a
 * missing weight are each an error that names the missing thing and exits
 * nonzero. Nothing here degrades quietly into doing less than it was asked.
 *
 * Two exit codes, and the distinction is deliberate:
 *   2  the command line was wrong (UsageError) — nothing ran
 *   1  the command ran and failed — read the message; the run directory still
 *      holds every artifact written before the failure
 */

import { UsageError } from './args.js';
import {
  COMMANDS,
  commandHelp,
  findCommand,
  formatOptionsBlock,
  runCommand,
  versionLine,
} from './commands.js';
import { versionString } from './version.js';

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
    '  page renders → scan → blocks → ocr → footnotes → export → EPUB',
    '',
    '  Every stage reads and writes ONE run directory (docs/PIPELINE.md), so a',
    '  run can be stopped, inspected, edited and resumed, and BookForge can read',
    '  the artifacts between stages. `convert` runs the lot.',
    '',
    'Global options:',
    formatOptionsBlock(),
    '',
    'Run `foundry <command> --help` for what a stage does.',
    `Version ${versionString()}.`,
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0) {
    process.stdout.write(`${topLevelHelp()}\n`);
    return;
  }

  const first = argv[0];

  if (first === '--help' || first === '-h' || first === 'help') {
    const target = argv[1] ? findCommand(argv[1]) : undefined;
    if (argv[1] && !target) throw new UsageError(`unknown command "${argv[1]}"`);
    process.stdout.write(`${target ? commandHelp(target) : topLevelHelp()}\n`);
    return;
  }

  if (first === '--version' || first === '-v' || first === 'version') {
    process.stdout.write(`${versionLine()}\n`);
    return;
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

  await runCommand(cmd, argv.slice(1));
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`foundry: ${err.message}\n\nRun \`foundry --help\`.\n`);
    process.exit(2);
  }
  // The message is the product here: every throw in this program is written to
  // name the missing thing and what to do about it, so it is printed alone. The
  // stack is behind FOUNDRY_STACK because a stack trace above that message
  // buries it.
  process.stderr.write(`foundry: ${err instanceof Error ? err.message : String(err)}\n`);
  if (process.env['FOUNDRY_STACK'] && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
