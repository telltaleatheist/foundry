/**
 * workspace-rendering-guards — what a rendering must refuse: one that would not compile, a stale narration stamp, and writing over edits.
 */
import { promises as fsp } from 'node:fs';
import { writeAtomically } from './atomic';
import { textDigestOf } from './narration-stamp';
import { ProjectError } from './projects';
import { editsInEffect } from '../shared/ledger';
import type { ConversionKind, LedgerStep, ProjectLedger } from '../shared/types';

/**
 * DOES THIS RENDERING READ A BOOK FILE, or does it replay a raw bank?
 *
 * ONE TEST, TWO ASKINGS. `planRendering` asks it to decide whether the export may
 * carry a person's changes at all; `materializeExport` asks it to decide whether
 * there is a book to make. Written twice they would be one `kind` apart from a
 * facsimile handed a book file it cannot read.
 *
 * EPUB AND TXT COMPILE; `--format pdf` reprints the scan's own photographed lines
 * from the raw bank (docs/RENDERER.md §6) and there is nothing about an edit for
 * it to carry.
 */
export function renderingCompiles(kind: ConversionKind): boolean {
  return kind === 'epub' || kind === 'txt';
}

/**
 * THE CLEANUP'S CLAIM, MINUS THE POSITIONS A MERGE COMPOSED THE WORDS OF.
 *
 * ── The gap this closes, as it was measured ─────────────────────────────────
 *
 * Owen's Pokemon book, 2026-09-18. He cleaned it for narration, then did an
 * ordinary afternoon's work on the workbench above the cleanup — 78 strikes, 13
 * chapter titles, one merge — and Narrate refused, naming `b11-6`. Measured over
 * the real project: the 78 strikes drifted nothing (they land as 64 SKIPPED
 * positions, which is exactly what the digest's own rule says they should), the 13
 * chapter ops drifted nothing, and the whole of the refusal was the single merge.
 * `{"op":"merge","id":"b13-0","into":"b11-6"}` left b11-6 holding its own cleaned
 * sentence followed by b13-0's cleaned `"Chapter one"`. Both halves are cleanup
 * output. Not one character of it was un-cleaned. The concatenation matches
 * neither digest, and a book nobody had un-cleaned was unnarratable.
 *
 * ── AND THE RULE IT EXTENDS IS THE DIGEST'S OWN ─────────────────────────────
 *
 * *"A person strikes a block after the cleanup ran … and the block is legitimately
 * gone from the book without one character of the remaining text having moved.
 * Refusing that would mean any edit that REMOVES something invalidates a cleanup
 * that is still entirely true about everything left, and the only way out would be
 * to re-buy the whole book's model time. So an absent position is SKIPPED AND
 * COUNTED."* (src/clean/digest.ts.) A merged position is that same sentence with
 * the block still in the flow: the words at it are cleanup output, nobody retyped
 * anything, and the alternative is re-buying the book. It is skipped for the same
 * reason and counted in the same breath.
 *
 * WHAT IS NOT SKIPPED IS THE THING THE CHECK IS FOR. A block somebody RETYPED is
 * not here — that is text the cleanup never saw, shipped under a claim that it
 * did, which is the whole defect the stamp exists to catch — and neither is the
 * original gap, an uncleaned parent book stamped with its child's receipt, which
 * still lands on `checkStampBlocks`' "not one of them" refusal because narrowing
 * only ever removes positions THIS replay composed.
 *
 * ── WHY MAIN NARROWS RATHER THAN THE ENGINE SKIPPING ────────────────────────
 *
 * Because the engine cannot know. It is handed a book file and a stamp and has
 * never heard of the op grammar (docs/RENDERER.md §9, R1) — the replay lives here —
 * so "this position's words were composed by a merge" is a fact only main holds.
 * The narrowing is therefore a claim main WITHDRAWS, never one it asserts: the
 * digests that remain are the clean run's own, byte for byte, and the engine
 * recomputes every one of them over the book it is holding exactly as before.
 *
 * ── AND THE NARROWED COPY IS SCRATCH, BESIDE THE BOOK IT IS ABOUT ───────────
 *
 * The cleanup's own stamp file is that step's receipt and is never rewritten — the
 * merge is a fact about this export, not about the run that cleaned the book, and
 * a second export from a row with no merge under it must get the whole claim back.
 * So the narrowed copy is written beside the derived book, named after it, in the
 * derived directory that `materializeBook` already sweeps.
 *
 * A FAILURE HERE HANDS BACK THE ORIGINAL STAMP rather than throwing. The worst
 * that does is reinstate the refusal this function exists to prevent, with the
 * engine's own sentence naming the blocks; throwing would fail an export outright
 * over a receipt, which is the trade `narrationStampFor` already refused to make.
 */
export async function narrowedStamp(
  stampPath: string,
  bookPath: string,
  restructured: readonly string[],
): Promise<string> {
  if (restructured.length === 0) return stampPath;
  try {
    const stamp: unknown = JSON.parse(await fsp.readFile(stampPath, 'utf8'));
    if (stamp === null || typeof stamp !== 'object' || Array.isArray(stamp)) return stampPath;
    const held = stamp as Record<string, unknown>;
    const blocks = held['blocks'];
    if (blocks === null || typeof blocks !== 'object' || Array.isArray(blocks)) return stampPath;

    const kept: Record<string, string> = {};
    const dropped: string[] = [];
    const composed = new Set(restructured);
    for (const [position, digest] of Object.entries(blocks as Record<string, unknown>)) {
      if (typeof digest !== 'string') continue;
      if (composed.has(position)) dropped.push(position);
      else kept[position] = digest;
    }
    if (dropped.length === 0) return stampPath;

    /*
     * A STAMP NARROWED TO NOTHING IS NOT HANDED ON. Every position the cleanup
     * covered having been composed by one chain's merges is not a book somebody
     * edited, it is a claim with nothing left in it — and `checkStampBlocks` reads
     * an empty `blocks` as nothing to check rather than as a refusal, which would
     * put "this text was cleaned" into a package document over no evidence at all.
     * The export goes out unstamped, which is `narrationStampFor`'s own answer for
     * a cleanup it cannot stand behind.
     */
    if (Object.keys(kept).length === 0) {
      console.error(
        `[workspace] ${stampPath} names ${dropped.length} cleaned position(s) and this export's `
        + 'changes composed the words of every one of them, so there is nothing left to check and '
        + 'the book is compiled saying nothing about narration.',
      );
      return '';
    }

    const file = `${bookPath.slice(0, -'.book.jsonl'.length)}.stamp.json`;
    const next = { ...held, blocks: kept, textDigest: textDigestOf(kept) };
    await writeAtomically(file, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
    console.error(
      `[workspace] ${dropped.length} cleaned position(s) had their words composed by a change `
      + `above the cleanup and are not claimed for this export — ${dropped.join(', ')}. The other `
      + `${Object.keys(kept).length} are checked as ever.`,
    );
    return file;
  } catch (err) {
    console.error(
      `[workspace] ${stampPath} could not be narrowed for this export `
      + `(${err instanceof Error ? err.message : String(err)}), so it goes to the engine whole.`,
    );
    return stampPath;
  }
}

/**
 * A CHAIN WITH APPLIED CHANGES IN IT CANNOT BE RENDERED BY THE BANK ROUTE, and
 * this is the one place that says so.
 *
 * ── Why a refusal is the only honest answer here ────────────────────────────
 *
 * The engine's `vlm-convert` compiles a book out of a readings bank and a
 * curation. It has never heard of the op grammar and it is never going to: the
 * changes a person makes on the proof sheet are ops in the ledger, replayed by
 * one implementation that lives in this process (docs/RENDERER.md §9, R1). So a
 * rendering that went down that route from a position with edit steps on its path
 * would run perfectly and produce a document with none of those changes in it —
 * the strikes back, the retyped sentences reverted, the relabelled headings as the
 * model first read them — and nothing on screen saying so. That is the worst
 * outcome available: silent, plausible, and discovered in a finished file.
 *
 * ── AND WHAT THE ROOT FIX TOOK OFF IT, TWICE ────────────────────────────────
 *
 * *"A person who struck forty running heads and pressed Export would file a book
 * that still has them."* Not any more: an EXPORT to EPUB or to plain text goes
 * through the compile now (`planExport`), in either language, so the sentence
 * this refusal was written to prevent is prevented by making the book properly
 * instead. And a TRANSLATION no longer comes here at all: `planTranslation`
 * materialises the position's book and the engine translates that file
 * (`translate --book`), so the strikes reach the model's input rather than being
 * faithfully translated into an edition of paragraphs somebody deleted.
 *
 * What still comes here is ONE rendering, and after R6 it is the only one left:
 *
 *  - A FACSIMILE, which reprints the scan's own photographed lines page for page.
 *    It is a record of the READING and compiles from the raw bank by definition
 *    (§6); there is nothing about an edit for it to carry.
 *
 * GENERATE used to be the other, and it is not a case this function lost — it is
 * a product that no longer exists. Its output was the `generated/` CAST, a
 * workbench EPUB carrying the very editing stamps an edition withholds, made so
 * that a pane had a file to unpack and show. The workbench renders the book file
 * directly now, so nothing needs a cast and the button that asked for one went
 * with the surface it fed (docs/RENDERER.md §7).
 *
 * ── ONE CHOKE POINT, NOT ONE PER BUTTON ─────────────────────────────────────
 *
 * `planRendering` is where every rendering in this app is composed — Generate,
 * Export, a landing's own cast, a facsimile — and every door in the UI goes
 * through it. Refusing at the buttons instead would be five copies of this rule
 * and a sixth door somebody adds without it.
 *
 * ── ASKED OF THE STEP WHEN THE PLAN IS ABOUT ONE ────────────────────────────
 *
 * `planRendering`'s own rule, and it keeps this from firing where it must not. A
 * read landing's facsimile is keyed to the read step, whose ancestry is the import
 * and itself — an edit made afterwards is a CHILD of that row and not an ancestor
 * of it — so the automatic reprint is never refused by an edit somebody makes
 * later. A save's cast under an edit chain IS refused, and rightly: that book
 * would be the same lie with a step's name on it, and `castStepBook` already
 * treats a plan it cannot make as a console line rather than a failed save
 * (electron/job-queue.ts).
 *
 * NAMED BY THE ROW, like every refusal in this function, and never by a file.
 */
export function refuseOverEdits(ledger: ProjectLedger, forStep: LedgerStep | null): void {
  const edits = editsInEffect(ledger, forStep);
  const oldest = edits[0];
  if (oldest === undefined) return;
  throw new ProjectError(
    edits.length === 1
      ? `“${oldest.label}” is on the way to where you are standing, and this one is built from the `
        + 'pages that were read rather than from the book you have been editing — so it would hand '
        + 'you a document with none of those changes in it. Export the book instead and every one of '
        + 'them is in what you get, or stand on a step below that one to make this.'
      : `${edits.length} rows of applied changes are on the way to where you are standing, beginning `
        + `with “${oldest.label}”, and this one is built from the pages that were read rather than `
        + 'from the book you have been editing — so it would hand you a document with none of them '
        + 'in it. Export the book instead and every one of them is in what you get, or stand on a '
        + 'step below the first of them to make this.',
  );
}
