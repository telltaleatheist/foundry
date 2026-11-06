/**
 * engine-stamp — the engine's stamp line, stamping an EPUB and finalizing it.
 */
import { engineCommand, runEngine } from './engine-run';

// ─────────────────────────────────────────────────────────────────────────────
// epub-stamp
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry epub-stamp` did, or the sentence saying why it would not. */
export interface StampOutcome {
  ok: boolean;
  /** Blocks given a `data-bf-cat` by this run. Zero on a book already stamped. */
  blocks: number;
  /** `data-bf-id` written where there was none. */
  ids: number;
  /** Spine documents the engine read. */
  documents: number;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * The completion line's contract, and it IS a contract.
 *
 * `epub-stamp`'s first report line is written to be read from here — see the
 * comment on `runEpubStamp` in src/commands.ts — the same way
 * `parseProgressLine` above reads the conversion's page counts off stderr. The
 * three phrases are the interface; the prose around them is free to change.
 *
 * A line that does not match is not an error: the run exited 0, so the book WAS
 * stamped, and the only thing lost is the app's ability to say how much. The
 * numbers are used to decide whether to reload a rendered chapter, and reloading
 * one that did not need it costs a scroll position.
 */
export function readStampLine(stderr: string): { blocks: number; ids: number; documents: number } {
  const number = (pattern: RegExp): number => {
    const match = pattern.exec(stderr);
    return match === null ? 0 : Number(match[1]);
  };
  return {
    blocks: number(/(\d+) blocks stamped/),
    ids: number(/(\d+) ids written/),
    documents: number(/epub-stamp: (\d+) documents?\b/),
  };
}

/**
 * Stamp a book: `foundry epub-stamp --epub <tree|file> [--out <file>]`.
 *
 * `target` is a working tree — a DIRECTORY, which the command stamps in place,
 * because that copy is ours and mutating it is the point — or an `.epub` file,
 * which requires `outPath` because foundry never writes over an input.
 *
 * NEVER THROWS. Both callers want a book either way: the import path opens a
 * book that could not be stamped and says so in the notice strip, and select
 * mode turns the refusal into its own sentence. A stamping failure is a fact
 * about the book, not a reason to lose it.
 */
export async function stampEpub(target: string, outPath?: string): Promise<StampOutcome> {
  const args = ['epub-stamp', '--epub', target];
  if (outPath !== undefined) args.push('--out', outPath);

  const run = runEngine(args);
  // A whole book's markup, parsed and rewritten. Minutes is wrong; two of them
  // is a hung process, and a hang here would hold an import open forever.
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    const unknown = result.code === 2 && /unknown command/i.test(said);
    return {
      ok: false,
      blocks: 0,
      ids: 0,
      documents: 0,
      reason: unknown
        ? `epub-stamp is not in this engine build (${engineCommand().source}).`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }

  return { ok: true, ...readStampLine(result.stderr), reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// epub-final
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry epub-final` did, or the sentence saying why it would not. */
export interface FinalOutcome {
  ok: boolean;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * Turn a book into the EDITION: `foundry epub-final --epub <book> --out <file>`.
 *
 * WHAT THE COMMAND IS FOR, in one line, because this app now has two doors onto
 * it: `generated/` is a workbench and keeps a curator's marks, and anything that
 * lands in `final/` is an edition — struck elements really removed, the notes and
 * contents entries they orphaned tidied, the reference numbers they left dangling
 * demoted back to the digit the page printed, and foundry's editing attributes
 * stripped. The fresh-cast route asks the engine for the same thing one stage
 * earlier (`vlm-convert --final`); this is the route for a book that already
 * exists.
 *
 * `--out` MAY NEVER BE `--epub`. The command refuses it — a tidy in place cannot
 * be run twice, because the second run would have nothing left to read — so every
 * caller here writes through a path of its own and the input survives untouched.
 *
 * NEVER THROWS, on `stampEpub`'s rule: this is one step of a save or of a queued
 * job, and both have a place to put a sentence. What the CALLER must not do is
 * treat a refusal as a success — a save that did not write the edition has not
 * saved, and `epub:save` rejects across IPC for exactly that reason.
 */
export async function finalizeEpub(epubPath: string, outPath: string): Promise<FinalOutcome> {
  const run = runEngine(['epub-final', '--epub', epubPath, '--out', outPath]);
  // A whole book's markup, parsed, tidied and rezipped. The same two minutes
  // `stampEpub` allows for the same work over the same book, and for the same
  // reason: past that, nothing is happening and a modal is waiting on it.
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    const unknown = result.code === 2 && /unknown command/i.test(said);
    return {
      ok: false,
      reason: unknown
        ? `epub-final is not in this engine build (${engineCommand().source}).`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }
  return { ok: true, reason: null };
}
