/**
 * capture-mint — a mint session: its pages, its commit into a PDF, and its abort.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { CaptureMintBegun, CaptureMintPage, LedgerStep } from '../shared/types';
import { arrangementOf, mintPlan } from '../shared/capture';
import { beginMint, cancelHere, mintCancelled, noteMintPage, settleMint } from './job-queue';
import { readManifest, recordMint } from './projects';
import { writeAtomically } from './atomic';
import { CaptureError, MINTS, captureDir } from './capture-paths';
import { readRecipe } from './capture-recipe';

// ─────────────────────────────────────────────────────────────────────────────
// The mint
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHO DOES WHAT, AND WHY IT IS SPLIT THIS WAY ─────────────────────────────
 *
 * MAIN decides the list, the sizes and the order; THE RENDERER rasterizes
 * exactly that list and sends back one JPEG at a time; MAIN assembles the PDF.
 * The rectifying happens in the renderer because it is a WebGL shader the
 * editor already runs for its live preview — one implementation, native speed —
 * and doing it here would mean a second one in JavaScript, seconds a page.
 *
 * ONE PAGE AT A TIME ACROSS THE BRIDGE, and each one lands on disk before the
 * next is asked for. A shoot is hundreds of megabytes of JPEG; holding it in
 * one heap to assemble at the end would put the whole book in memory twice, in
 * a process that also has an app in it.
 *
 * THE PAGES ARE STAGED INSIDE THE PROJECT rather than in the system temp
 * directory. A mint interrupted by a crash leaves a numbered directory under
 * `capture/mints/` that nothing reads and the next mint does not touch. That is
 * a visible mess in one folder, which is better than an invisible one in
 * %TEMP% — and a project's own folder is where a person looking for a book that
 * did not finish would think to look. (For two days the commit was a RENAME out
 * of this directory rather than a read of it, and staging inside the project was
 * what kept that on one volume. The commit assembles again, so the staging is a
 * scratch area once more; it stays here because the first reason never depended
 * on the second.)
 */
export interface MintSession {
  projectDir: string;
  /** The shelf row. The renderer never sees this; a cancel arrives through it. */
  jobId: string;
  staging: string;
  pages: CaptureMintPage[];
  /**
   * The fingerprint of the recipe THIS mint was begun from, carried to the step.
   *
   * Held on the session rather than re-read at commit for the reason
   * `recordMint` states: a mint takes minutes, the recipe is editable
   * throughout, and the arrangement recorded must be the one these pages were
   * rasterized from rather than whatever the file says when the last page lands.
   */
  arrangement: string;
  received: Set<number>;
}

export const mints = new Map<string, MintSession>();

export function sessionOf(mintId: string): MintSession {
  const session = mints.get(mintId);
  if (session === undefined) {
    throw new CaptureError(
      `There is no mint called ${mintId} in progress. It was finished, given up on, or belongs to a `
      + 'run of this app that has since closed.',
    );
  }
  return session;
}

export async function forget(session: MintSession, mintId: string): Promise<void> {
  mints.delete(mintId);
  await fsp.rm(session.staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
}

/**
 * Work out what this mint will print, and open a session for it.
 *
 * ── MAIN DENORMALIZES EXACTLY ONCE, AND THIS IS THE ONCE ────────────────────
 *
 * The recipe is fractions from end to end. Here they are multiplied by the
 * working copy's decoded dimensions and never again — the renderer is handed
 * `quadPx` in pixels beside the `sourceWidth`/`sourceHeight` they were computed
 * against, so it can ASSERT its decoded bitmap matches what main measured
 * rather than trusting it. There is no second conversion anywhere to disagree
 * with this one, which is the guarantee that makes `PixelQuad` being a mere
 * alias tolerable.
 *
 * ── THE ORDER IS THE ORDER, AND STRIKES ARE DROPPED HERE ────────────────────
 *
 * `recipe.order` lists every page id including struck ones, and this is the one
 * place they are filtered. The renderer receives a list that is already the
 * book: no strike logic on that side, no chance of the two sides disagreeing
 * about which leaf is in.
 */
export async function mintBegin(projectDir: string): Promise<CaptureMintBegun> {
  const recipe = await readRecipe(projectDir);
  /*
   * THE WHOLE LIST COMES FROM `shared/` NOW, not just the page ids — so the
   * number the footer promised, the number the editor read out, the pages this
   * prints AND the arrangement recorded on the step are one body of one rule
   * (see `mintPlan`, and `mintedPageIds` for the third time this rule had more
   * than one). The fingerprint is taken from THIS read of the recipe rather than
   * at commit, so it describes the book that was actually rasterized even if
   * somebody edits the file in the minutes a mint takes.
   */
  const { pages, missing } = mintPlan(recipe);
  const arrangement = arrangementOf(recipe);
  /*
   * STILL REFUSED HERE RATHER THAN TRUSTED. `mintedPageIds` drops an id that
   * names no page, which is the right answer for a COUNT on screen — a number
   * beside a button must not throw. It is the wrong answer for the mint: a
   * book quietly short a leaf is the failure the order cross-check exists to
   * prevent, so reaching this means the file changed under us between the load
   * and the mint, and that is worth stopping for.
   */
  if (missing.length > 0) {
    throw new CaptureError(
      `The recipe lists a page (${missing[0]}) that no photograph holds. Reopen the project before minting.`,
    );
  }

  if (pages.length === 0) {
    throw new CaptureError(
      'Every page in this project is struck, so there is nothing to mint. Restore a page first.',
    );
  }

  const mintId = randomUUID();
  const staging = path.join(captureDir(projectDir), MINTS, mintId);
  await fsp.mkdir(staging, { recursive: true });
  const manifest = await readManifest(projectDir).catch(() => null);
  mints.set(mintId, {
    projectDir,
    jobId: beginMint(projectDir, manifest?.title ?? path.basename(projectDir), pages.length),
    staging,
    pages,
    arrangement,
    received: new Set<number>(),
  });
  return { mintId, pages };
}

/**
 * One rectified page, as the renderer finished it.
 *
 * THE CANCEL IS CHECKED HERE and nowhere else. Pressing ✕ sets the shelf row to
 * cancelled in a microsecond, but the renderer is midway through a page and will
 * keep sending; nothing in main can reach across and stop it. So the first page
 * to arrive after a cancel is refused, the staging directory goes, and the
 * renderer learns the mint is over by being told no. Within one page, rather
 * than instantly — which for a stage measured in minutes is the same thing.
 */
export async function mintPage(mintId: string, index: number, jpeg: ArrayBuffer): Promise<void> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled, so its pages are no longer being collected.');
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.pages.length) {
    throw new CaptureError(
      `Page ${index} is not one of the ${session.pages.length} pages this mint asked for.`,
    );
  }
  await writeAtomically(path.join(session.staging, `${index}.jpg`), Buffer.from(jpeg));
  session.received.add(index);
  noteMintPage(session.jobId, session.received.size);
}

/** Nominal dots per inch for the page box. 72 points to the inch. */
export const MINT_DPI = 300;

/**
 * Assemble the PDF, file it as the project's imported original, answer with the
 * step.
 *
 * ── THE MINT PRODUCES A PDF, AND FROM THAT MOMENT THIS IS AN ORDINARY BOOK ──
 *
 * Owen, 2026-08-22, in two messages, and they are the whole of this wave:
 *
 *   *"maybe we should mint a pdf from the pages after theyre fully arranged and
 *   complete, and then we build the bank after that (not necessarily from the
 *   pdf, but the pdf can exist so it doesnt confuse bookforge or anything else).
 *   the pdf is just the images on each page."*
 *
 * and, when told this would also retire a night's worth of special paths:
 *
 *   *"this might fix our current problem as well. the system isnt trying to sift
 *   through images, it's using the original pdf just like it normally would."*
 *
 * A third message settled the read, and it is recorded again where the reading
 * is planned (`planReading`, electron/workspace.ts): *"if we're building the
 * bank from the images anyway maybe we should just build it from the pdf. why
 * not? it would help maintain provenance, and nothing will be lost."*
 *
 * ── WHAT THIS REVERSES, AND WHY THE REVERSAL IS NOT A REGRESSION ────────────
 *
 * At `ecbf238` the assembly was taken OUT on the argument that a PDF was a round
 * trip: the mint drew one JPEG per page into a container and the read rasterised
 * the container straight back into one image per page. That argument was true
 * about the READ and silent about everything else, and everything else is what
 * broke. A folder is not a file, so `manifest.archive.file` named a DIRECTORY,
 * and every consumer that asks a project "what were you made from" hit it in
 * turn: the three make-dialogs, the page viewer, the figure cutter, and finally
 * BookForge's adoption, which refuses a project whose *"catalogue's archive names
 * no file"*. Each was patched alone. The container is the answer to all of them
 * at once, and the round trip it costs is seconds against a read measured in
 * hours.
 *
 * ── AN IMAGE-ONLY PDF, WHICH IS THE ENTIRE OUTPUT OF THIS STAGE ─────────────
 *
 * One JPEG per page, drawn to fill its own page box, no text layer and no fonts —
 * *"the pdf is just the images on each page"*, verbatim. `embedJpg` takes the
 * encoded bytes as they are, so no page is decoded, resampled or re-encoded on
 * the way in: the pixels in the container are the pixels the renderer rectified.
 *
 * THE PAGE BOX IS THE PIXELS AT A NOMINAL 300 DPI. Nothing is resampled: the
 * JPEG goes in at its own resolution and the box is sized to suit it, so the
 * declared page is roughly the physical page it was photographed from. The read
 * stage rasterizes at its own budget later; this number never constrains it.
 *
 * ── THE STAGED PAGES ARE CONSUMED, AND NO FOLDER IS LEFT BEHIND ─────────────
 *
 * THE CALL, STATED: a new mint leaves NO `archive/<stem> pages/` directory. The
 * JPEGs go into the container byte for byte, so a folder beside it would be a
 * second complete copy of a shoot that runs to hundreds of megabytes, kept for
 * readers that no longer exist — the page view, the `--pages` read and the
 * `--pages` figure cut are all off the app's paths as of this wave. The record
 * of every rectified page is the PDF, which is the one thing Owen asked for.
 *
 * (The HEAL is the other way round and deliberately so: a project that already
 * holds a pages folder KEEPS it, because deleting somebody's data to tidy a
 * migration is not a thing this app does. See `healMintedArchive`.)
 *
 * ── THE READING ORDER IS THE MINT'S OWN PAGE NUMBERING ──────────────────────
 *
 * `session.pages` is the list `mintBegin` built from `recipe.order` with the
 * struck pages already dropped, in the order the book is read; the renderer
 * rasterised exactly that list and returned each page by its INDEX in it. So
 * walking the indices in ascending order is the book, and there is no second
 * ordering rule anywhere to disagree with it.
 *
 * REFUSES A BOOK WITH A HOLE IN IT. Every page main asked for must have come
 * back. A missing one would print a book quietly short a leaf, which is exactly
 * the failure the order cross-check exists to prevent one layer up.
 *
 * ── ONE HEAP'S WORTH, AND THAT IS THE COST OF A CONTAINER ───────────────────
 *
 * `MintSession` above explains why pages cross the bridge one at a time and land
 * on disk as they arrive: a shoot held whole in the main process is the book in
 * memory twice, in a process that also has an app in it. The assembly gives some
 * of that back — pdf-lib holds every embedded JPEG and then serialises the lot
 * into one array — and it is named here rather than discovered, because it is the
 * price of the container and the container is what the ruling asks for. Nothing
 * is DECODED, so the peak is the encoded book and not its pixels.
 */
export async function mintCommit(mintId: string): Promise<LedgerStep> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled before it could be finished.');
  }
  const missing = session.pages
    .map((_page, index) => index)
    .filter((index) => !session.received.has(index));
  if (missing.length > 0) {
    throw new CaptureError(
      `${missing.length} of ${session.pages.length} pages never arrived, so this book would be `
      + `short a leaf. Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}.`,
    );
  }

  try {
    const step = await recordMint(
      session.projectDir,
      await assemblePdf(session),
      session.arrangement,
    );
    settleMint(session.jobId, { file: path.join(session.projectDir, ...step.payload.split('/')) });
    await forget(session, mintId);
    return step;
  } catch (err) {
    // The row must not sit at `running` for the rest of the session because an
    // embed threw. The staging pages are kept: the failure is worth looking at.
    settleMint(session.jobId, { error: err instanceof Error ? err.message : String(err) });
    mints.delete(mintId);
    throw err;
  }
}

/**
 * The staged pages, in order, as one image-only PDF.
 *
 * Split out of `mintCommit` so that the commit reads as what it is — refuse a
 * hole, assemble, record — and because the assembly is the one part of it that
 * touches a foreign library. `mintCommit`'s docblock carries the argument; this
 * carries the mechanics.
 *
 * THE SIZES ARE THE ONES MAIN ASKED FOR, not the ones the JPEG declares. Main
 * computed `outWidth`/`outHeight` at `mintBegin` and the renderer asserted its
 * bitmap against them, so they are the agreed dimensions of the page; asking
 * pdf-lib for the embedded image's own size instead would be a second
 * measurement of the same thing, taken from the far side of the bridge.
 */
export async function assemblePdf(session: MintSession): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < session.pages.length; index++) {
    const asked = session.pages[index]!;
    const jpeg = await fsp.readFile(path.join(session.staging, `${index}.jpg`));
    const image = await pdf.embedJpg(jpeg);
    const width = (asked.outWidth * 72) / MINT_DPI;
    const height = (asked.outHeight * 72) / MINT_DPI;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdf.save());
}

/** Give up. Nothing is left behind and no step is appended. */
export async function mintAbort(mintId: string): Promise<void> {
  const session = mints.get(mintId);
  if (session === undefined) return; // giving up twice is giving up
  cancelHere(session.jobId);
  await forget(session, mintId);
}
