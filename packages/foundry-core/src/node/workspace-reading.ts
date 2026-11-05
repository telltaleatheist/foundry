/**
 * workspace-reading — where a reading and a facsimile are written.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { bankForReading, importDocument, readManifest } from './projects';
import type { ReadAsk } from '../shared/ledger';
import type { LedgerStep, ReadingPlan, WorkspacePlan } from '../shared/types';
import { archiveOriginal } from './workspace-records';
import { GENERATED, planRendering } from './workspace-rendering';

/**
 * Where this book's ANSWERS go — everything an OCR job needs, and no more.
 *
 * ── Why this is not a rendering plan with a field left out ──────────────────
 *
 * The two jobs want different things and the difference is the whole point of
 * splitting the front door. A reading has no output file, so there is no name to
 * compose and no `generated/` predecessor to rotate aside; it has no format, so
 * there is no extension for a `--format` to contradict. What it has is a source
 * of pixels and a bank to fill.
 *
 * IT STILL RESOLVES THE PIXELS ITSELF, which is the one thing both plans share
 * and the reason neither of them takes the user's word for the input. Somebody
 * points at "the PDF", meaning the one this app shows them — and after a
 * real-text rendering that document is type on blank paper with no photograph in
 * it at all. Reading THAT would be reading a reprint of a reading. So the source
 * is `archive/`, always, and the person asking never has to know there is more
 * than one copy.
 *
 * The directories are made here rather than by the engine, because the engine is
 * handed a path and a path whose parent does not exist is a run that dies after
 * the last page.
 */
export async function planReading(
  inputPath: string,
  /**
   * WHAT THE DIALOG ASKED, and the reason this plan takes an argument it never
   * used to need.
   *
   * The bank's path is no longer a fact about the project — it is a fact about
   * WHICH READING this is, and that is decided by comparing what was asked with
   * what the project's existing readings were asked (`bankForReading`). Read the
   * same pages again and this is a replace, aimed at the step that already exists;
   * ask for a different page range and it is a branch, which gets a bank of its
   * own so the older row goes on naming the reading it is actually about.
   *
   * So the two fields the OCR form holds have to reach the plan, and reach it
   * BEFORE the enqueue: the engine is handed one path and fills it for three
   * hours, and by the time anything lands there is nothing left to decide.
   *
   * Defaulted for a caller with nothing to say, which asks the plain question —
   * the whole book, no language declared — exactly as `recordReading` does.
   */
  asked: ReadAsk = {},
): Promise<ReadingPlan> {
  /*
   * ── THE BANK IS READ FROM THE PDF, WHATEVER THE BOOK ARRIVED AS ───────────
   *
   * Owen, 2026-08-22, closing a question this function had been answering two
   * ways for two days:
   *
   *   *"if we're building the bank from the images anyway maybe we should just
   *   build it from the pdf. why not? it would help maintain provenance, and
   *   nothing will be lost."*
   *
   * This chose between `--pdf` and `--pages` off `manifest.archive.kind`,
   * because a captured project's archive was a FOLDER of rectified page images
   * and the engine had learned to read one at Wave 21. That was efficient and it
   * gave one kind of book a different history from every other: a bank made from
   * pictures, with no document anywhere between the photographs and the text.
   *
   * A mint writes an image-only PDF now (`recordMint`) and every project made
   * before it is healed into one, so the chain is bank ← PDF ← pages for a
   * photographed book exactly as it is bank ← PDF for a scanned one. ONE INPUT,
   * ONE STORY. The rasterisation the folder route saved is seconds against a
   * read measured in hours, and nothing is lost: the pixels in the container are
   * the pixels the mint rectified, embedded without a re-encode.
   *
   * ── WHAT IS POINTED AT IS A DOCUMENT AGAIN ────────────────────────────────
   *
   * For those two days the OCR dialog offered THE PROJECT for a captured book,
   * because there was no document to offer, and this recognised a project
   * directory by its being one. It offers the project's ORIGINAL now, like every
   * other book in the list, so what arrives here is a path to a file — and
   * `importDocument`'s own inside-a-project rule resolves it to the project it
   * is already in without copying anything.
   *
   * THE SOURCE IS `archive/`, ALWAYS, and the person asking never has to know
   * there is more than one copy. Somebody points at "the PDF", meaning the one
   * this app shows them — and after a real-text rendering that document is type
   * on blank paper with no photograph in it at all. Reading THAT would be
   * reading a reprint of a reading.
   */
  const dir = (await importDocument(inputPath, 'pdf')).dir;
  const manifest = await readManifest(dir);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  const bank = await bankForReading(dir, asked);
  const sourcePath = await archiveOriginal(dir) ?? inputPath;
  return {
    key: manifest.key,
    sourcePath,
    readingsPath: bank.readingsPath,
    // Minted with the path and spent at the landing, so the file and the row agree
    // about which reading the bank belongs to. See `ReadRequest.stepId`.
    stepId: bank.stepId,
  };
}

/**
 * Where this READING's page-for-page record goes — the same rendering, aimed at
 * `generated/` as a PDF and keyed to the read step that made the bank.
 *
 * ── Why a reading gets a second product, unasked ────────────────────────────
 *
 * Because a bank is not a thing anybody can look at, and the flowing book is
 * only half of what is in it. The other half is the pages as they were printed,
 * set back as real text: *"from the bank, pdf facsimile can be generated. that's
 * a terminal item"* (docs/RENDERER.md §0 A3, §6). It costs what every other cast
 * costs — `--reuse-readings` over a bank marked complete one line earlier, no
 * model, no socket, seconds — which is the whole of why it can happen without
 * anybody pressing anything.
 *
 * ── PDF, always, and keyed to the step rather than to the position ──────────
 *
 * A facsimile is the only thing this plan can be: `--format pdf` reprints the
 * scan's own photographed lines, which is a statement about the READING and not
 * about any state of the book downstream of it. And it is keyed to the step
 * because a project can hold two readings — a re-read asking for a different
 * page range branches by design — so a plan that asked the POSITION which bank
 * to replay would reprint whichever reading the pointer happened to be under
 * while the name said this one. Both halves of that agreement are made here:
 * `readingBank` resolves the step's own payload, and `facsimileFile` names the
 * file after the same step.
 *
 * IT COMPILES FROM THE RAW BANK AND FROM NOTHING ELSE (§6) — no decisions, no
 * ops, no edits. A facsimile is the record of what was READ, and a page-for-page
 * reprint that had somebody's strikes applied to it would be a record of
 * something that was never on the page.
 */
export async function planFacsimile(
  inputPath: string,
  step: LedgerStep,
): Promise<WorkspacePlan> {
  // The same step twice, and it is the one product for which that is honest: a
  // facsimile is made FROM the reading and named FOR it. See `planRendering`.
  return (await planRendering(inputPath, 'pdf', GENERATED, step, step)).plan;
}
