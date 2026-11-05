#!/usr/bin/env bun
/**
 * foundry — recast a broken scan into a clean book.
 *
 * A type foundry casts worn type into fresh type. This one hands each page of
 * a badly scanned PDF to a document vision model, takes back marked-up text,
 * and assembles the answers into a readable EPUB (src/vlm/). The Tesseract +
 * stage-model pipeline that used to live beside this route is preserved at the
 * git tag `pre-vlm-strip`.
 *
 * Entry point. Dispatch only — the work lives in its own modules, and this
 * file's job is to turn argv into exactly one command and to make failure loud.
 *
 * NO FALLBACKS. An unknown command, a missing file, a missing interpreter and
 * a missing package are each an error that names the missing thing and exits
 * nonzero. Nothing here degrades quietly into doing less than it was asked.
 *
 * Two exit codes, and the distinction is deliberate:
 *   2  the command line was wrong (UsageError) — nothing ran
 *   1  the command ran and failed — read the message; whatever the run banked
 *      before the failure (--readings) is still on disk
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
import { ownTheFetchDeadlines } from './http-deadlines.js';
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
    '  vlm-convert --pdf … --out book.epub',
    '',
    '  A document vision model reads each page image and writes marked-up text,',
    '  and foundry assembles the answers into an EPUB. It needs a Python with',
    '  PyMuPDF (and mlx-vlm for the local MLX path); --vlm-endpoint sends the',
    '  pages to a Crucible instead, which publishes what a page request is.',
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

/*
 * EXIT ONLY ONCE STDERR HAS DRAINED. Under Node a write to a pipe can still be
 * in flight when `process.exit` runs (on macOS pipes are asynchronous), and the
 * sentence this program exists to print is the thing that would be cut. So the
 * exit runs from the write's own callback, after the bytes are out. The success
 * path never calls exit at all — `main` returns and the process ends when it is
 * idle, which is what lets a large stdout finish.
 */
function exitAfter(message: string, code: number): void {
  process.stderr.write(message, () => process.exit(code));
}

ownTheFetchDeadlines();

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    exitAfter(`foundry: ${err.message}\n\nRun \`foundry --help\`.\n`, 2);
    return;
  }
  // The message is the product here: every throw in this program is written to
  // name the missing thing and what to do about it, so it is printed alone. The
  // stack is behind FOUNDRY_STACK because a stack trace above that message
  // buries it.
  let message = `foundry: ${err instanceof Error ? err.message : String(err)}\n`;
  if (process.env['FOUNDRY_STACK'] && err instanceof Error && err.stack) {
    message += `${err.stack}\n`;
  }
  /*
   * A PARK IS NOT A FAILURE, and the exit code is how a dispatcher can tell.
   * A throw that carries its own exit code (`VlmParkedError`, exit 75: the
   * server's weather outlasted its budget, every page that landed is banked,
   * run the same command again) exits by it; everything else is 1. Read off
   * the error rather than by class so this file does not import the reader's
   * vocabulary to learn one number.
   */
  const carried = err instanceof Error ? (err as { exitCode?: unknown }).exitCode : undefined;
  exitAfter(message, typeof carried === 'number' ? carried : 1);
});
