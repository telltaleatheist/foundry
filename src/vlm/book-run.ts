/**
 * vlm/book-run — the bank, reflowed into a book file, once.
 *
 * The stage the user asked to run the moment a reading finishes: *"lets render a
 * facsimile pdf the moment the vlm finishes, and then reflow the bank
 * immediately. fix hyphenated words, join paragraphs split across pages, etc."*
 * `book-file.ts` holds the format and the whole of the reasoning; this holds the
 * run — open the bank, parse every page, hand the pages to `reflowBook`, and
 * write what comes back.
 *
 * IT ADDS NO RULES. Every correction in the product is `reflowBook`'s and was
 * already being applied, freshly, on every render of the book: the running heads
 * the model mistagged are dropped, a heading printed on two lines is one
 * heading, the text is dehyphenated against the book's own lexicon, the print
 * lines are reflowed back into prose, and a paragraph the printer broke across a
 * leaf is one paragraph. What changes is that the answer is now WRITTEN DOWN
 * rather than recomputed, which is what lets the seams it could not decide be
 * fixed by hand and stay fixed.
 *
 * NO MODEL, AND NO RASTERISER UNLESS THERE IS A PICTURE AND A PAGE TO CUT IT OUT
 * OF. A bank written by this version records the render size and the pixel
 * budget beside every answer, which is the entire frame a box needs; a bank old
 * enough to lack them is REFUSED BY NAME rather than rendered again behind
 * somebody's back. What a source buys is the one thing arithmetic over the bank
 * cannot produce: a Picture block is pixels by definition, and the pixels are in
 * the pages the book was read out of. Only the pages that carry one are opened,
 * so a three-hundred page book with four figures pays for four pages, and a run
 * with no source still costs about as long as reading the bank off the disk.
 *
 * ── A REFLOW TAKES PAGES TOO — Wave 37, and it is the read's own lesson ──────
 *
 * `--pdf` was this command's only way to have any pixels, and the read stopped
 * believing that in Wave 34: *"a read takes PAGES — a PDF is one way to have
 * some pages, not the only way"* (907dc59). The reflow never learned it, and the
 * asymmetry was the whole of a defect Owen hit exporting a captured book — its
 * archive is a folder of page photographs, so its reflow ran with no source, cut
 * nothing, and every Picture block in it refused at export while the pixels sat
 * in the archive one directory away. So `--pages <dir>` stands beside `--pdf`
 * here exactly as it does there, over the same `VlmSource`, ordered by the same
 * `pagesInDirectory`, and everything downstream of the crop cannot tell which
 * face it was handed.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import {
  bookFile,
  figureName,
  formatBookFile,
  type BookFigures,
  type BookRow,
  type BookSource,
} from './book-file.js';
import { cropPageRenders, pagesInDirectory, sourceName, type VlmSource } from './bridge.js';
import { DotsPageError, parseDotsPage, type DotsBlock, type DotsParsedPage } from './dots.js';
import { openPageImages, reflowBook, type DotsCrop } from './dots-book.js';
import { VLM_DPI } from './read.js';
import { VlmReadings } from './readings.js';

export class BookRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookRunError';
  }
}

export interface BookRunOptions {
  readingsPath: string;
  outPath: string;
  /** The read's declared language, for the header. Declared, never detected. */
  language: string;
  /**
   * The archived original, for the figure crops and for NOTHING else — it is
   * opened, never written, and a run without it writes a book with no images in
   * it and says so.
   *
   * EXACTLY ONE OF THIS AND `pagesDir`, or neither. See `figureSource`.
   */
  pdfPath?: string;
  /**
   * The archived PAGES, for the same one purpose — the photographs a capture
   * project made, which are the book's leaves themselves.
   *
   * A SECOND FIELD RATHER THAN A SECOND MEANING FOR `pdfPath`, which is the
   * app's own rule at the other end of this call (`bookAtPosition` keeps `pdf`
   * and `pages` apart for the same reason): they are opened by different code,
   * they are named by different things in the manifest, and a caller that
   * conflated them would hand a directory to something that opens documents.
   */
  pagesDir?: string;
  /** The interpreter with PyMuPDF in it, where the crops need one. */
  python?: string;
  log: (line: string) => void;
}

export interface BookRunReport {
  rows: BookRow[];
  /** Pages whose answer would not parse, by number and reason. Never fatal. */
  unreadable: { page: number; reason: string }[];
  /** Pages whose opening paragraph was joined onto the previous page's. */
  joinedPages: number[];
  /**
   * The page turns the rule would NOT join — the seams a person has to decide.
   *
   * Reported loudly because they are the whole reason this file is editable: a
   * join it declined is a paragraph that will read as two until somebody says
   * otherwise, and now saying so is a change to a document rather than an
   * argument with a heuristic that runs again tomorrow.
   */
  unjoinedTurns: number[];
  /** Blocks whose print line breaks were reflowed back into prose. */
  reflowed: number;
  /** The blocks that are in the file and out of the book — §5, counted. */
  shelved: { furniture: number; suppressedHeads: number };
  /** The figures cut out of the page renders. Empty where no PDF was named. */
  images: string[];
}

/**
 * The receipt, identified — the first sixteen hex of a sha-256 over its bytes.
 *
 * OVER THE BYTES AND NOT OVER ANYTHING PARSED OUT OF THEM. The point of this
 * number is to answer "is the file underneath this book the same file", and a
 * hash of the answers this run happened to read would say yes to a bank that had
 * grown three pages since. It is the cheapest possible reading of the file that
 * is also the strictest one, and the file is already being read.
 */
function bankSha(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Where the figures go: `readings/<key>.images/`, beside the bank they were cut
 * out of the answers of.
 *
 * NAMED AFTER THE BANK AND NOT AFTER `--out`, which is the same pairing rule
 * `completionMarkerPath` learned the hard way. The book file is regenerable and
 * can be written anywhere somebody points it; the crops belong to the READING,
 * they are swept with it, and a second book file written to a temporary
 * directory must not scatter a second copy of the pictures beside itself.
 */
function imagesDir(readingsPath: string): string {
  const resolved = path.resolve(readingsPath);
  return `${resolved.replace(/\.jsonl$/i, '')}.images`;
}

/**
 * The pages the figures will be cut out of, or null where the run was given
 * none — and a refusal where it was given two.
 *
 * BOTH IS AS WRONG AS ONE IS RIGHT, and it is refused rather than resolved by a
 * precedence rule, which is `sourceFor`'s ruling in src/vlm/read.ts and holds
 * here for the same reason: there is no reading of "--pdf and --pages" that is
 * obviously right, and a script that passes both would otherwise have its
 * figures cut out of whichever one this file happened to test first.
 *
 * NEITHER IS NOT AN ERROR, and that is the difference from the read. A read with
 * no pages has nothing to do at all; a reflow with no pages has a whole book to
 * write and only its pictures to leave out — which it does, out loud, in
 * `cutFigures`.
 *
 * THE ORDER OF THE PAGES IS `pagesInDirectory`'s AND IS NEVER RE-DERIVED HERE.
 * That is the one rule that makes a figure land on the page it was printed on:
 * the read banked its answer for page N against `pagesInDirectory(dir)[N - 1]`,
 * and page N of this bank has to mean that same file or a crop comes off the
 * next leaf. One function, called twice, is the only way that stays true when
 * somebody's filenames are `IMG_2.jpg` through `IMG_130.jpg`.
 */
function figureSource(opts: BookRunOptions): VlmSource | null {
  if (opts.pdfPath !== undefined && opts.pagesDir !== undefined) {
    throw new BookRunError(
      '--pdf and --pages are two different things to cut this book\'s figures out of: a document to '
      + 'rasterise, and the photographs of the pages themselves. Pass one, or neither and no figure '
      + 'is cut.',
    );
  }
  if (opts.pdfPath !== undefined) {
    const pdfPath = path.resolve(opts.pdfPath);
    if (!fs.existsSync(pdfPath)) throw new BookRunError(`no such PDF: ${pdfPath}`);
    return { kind: 'pdf', path: pdfPath };
  }
  if (opts.pagesDir === undefined) return null;
  const dir = path.resolve(opts.pagesDir);
  if (!fs.existsSync(dir)) {
    throw new BookRunError(
      `no such directory: ${dir}. The figures are cut out of the pages this book was read from, and `
      + 'they are not there.',
    );
  }
  const paths = pagesInDirectory(dir);
  if (paths.length === 0) {
    throw new BookRunError(
      `${dir} holds no page images, so there is nothing to cut a figure out of. It is the folder the `
      + 'pages of this book were read from; a reflow pointed at an empty one would write a book '
      + 'whose pictures are silently missing.',
    );
  }
  return { kind: 'pages', paths };
}

export async function buildBookFile(opts: BookRunOptions): Promise<BookRunReport> {
  /*
   * THE SOURCE IS SETTLED BEFORE THE BANK IS OPENED, so a run given two of them
   * — or one that is not there — is answered in a second rather than after three
   * hundred pages have been parsed and reflowed for nothing.
   */
  const cutFrom = figureSource(opts);
  const readingsPath = path.resolve(opts.readingsPath);
  if (!fs.existsSync(readingsPath)) {
    throw new BookRunError(
      `no such readings file: ${readingsPath}. This command reflows a bank of page answers into a `
      + 'book; it reads no page from a model, so an absent bank is nothing it can make up for.',
    );
  }

  // Opened, never judged — `dumpBlocks`' rule, for its reason: no completion
  // marker is written and nothing is archived, so this is safe to run over a
  // bank in the middle of somebody's reading.
  const readings = VlmReadings.open(readingsPath);
  // Read as BYTES, once, beside the parse — the identity of the receipt is a
  // fact about the file and not about what this run made of it. See `bankSha`.
  const sha = bankSha(fs.readFileSync(readingsPath));
  const pages = readings.pages();
  if (pages.length === 0) {
    throw new BookRunError(
      `${readingsPath} banks no page answers, so there is no book in it yet. A reading that has not `
      + 'started has an empty bank, and so does a path that names the wrong file.',
    );
  }

  const parsed: DotsParsedPage[] = [];
  const unreadable: { page: number; reason: string }[] = [];
  for (const page of pages) {
    const reading = readings.get(page)!;
    const banked = readings.geometry(page);
    if (banked === null) {
      throw new BookRunError(
        `page ${page} of ${readingsPath} banks no render size, so its boxes have no frame to be `
        + 'measured in. That bank was written before runs recorded their geometry; re-read the book, '
        + 'or use vlm-blocks --pdf, which rasterises the pages again to measure them.',
      );
    }
    try {
      parsed.push(parseDotsPage(reading.text, {
        page,
        render: banked.render,
        maxPixels: banked.maxPixels,
      }));
    } catch (err) {
      if (!(err instanceof DotsPageError)) throw err;
      /*
       * ONE BAD PAGE MUST NOT COST THE OTHER TWO HUNDRED AND NINETY-NINE, which
       * is the promise every command over a bank makes. It is named and skipped,
       * and the book is written without it — the alternative is a reading that
       * cost hours producing nothing because the model garbled one page.
       */
      unreadable.push({ page, reason: err.message.replace(/^page \d+: /, '') });
    }
  }
  if (parsed.length === 0) {
    throw new BookRunError(
      `not one of the ${pages.length} banked page(s) in ${readingsPath} could be parsed, so there `
      + 'is no book to write. The reasons are above, page by page.',
    );
  }

  const flow = reflowBook({ pages: parsed });
  /*
   * THE FURNITURE THE PARSE SET ASIDE, RECOVERED HERE AND NOT IN THE REFLOW.
   *
   * `parseDotsPage` sorts the tagged Page-header and Page-footer blocks out of
   * `blocks` into `furniture`, and `reflowBook` reads that list once (to learn
   * which running heads the model has attested somewhere) and never carries it
   * forward, which is correct: they are not the book, and the reflow's product
   * is the book. They ARE rows of the file (§5 of the contract), so they are
   * picked up from the pages this function already holds rather than by growing
   * the reflow a return value it has no use for. Nothing above has moved them —
   * `suppressRunningHeads` reads the list and `mergeAdjacentHeadings` rewrites
   * `blocks` — so this is the parse's own answer, in the parse's own order.
   */
  const furniture: DotsBlock[] = parsed.flatMap((page) => page.furniture);
  const source: BookSource = {
    pages: pages.length,
    unreadable,
    // `generation` is deliberately not here: the bank records none, and §2 marks
    // the field optional by absence precisely so that nothing has to invent one.
    bankSha: sha,
  };
  const book = bookFile({ flow, furniture, language: opts.language, source });
  const rows = book.rows;
  const shelved = rows.filter((row) => row.shelf !== undefined);
  /*
   * The page turns that WERE joined, counted off the flow blocks themselves.
   *
   * `FlowBook` reports the ones it declined (`unjoinedTurns`) and not the ones it
   * made, because until now the count was taken while the markup was written —
   * one page further downstream. Here the answer is in front of us: a part whose
   * page differs from the part before it in the same block is a leaf the printer
   * broke and this pass put back together.
   */
  const joinedPages: number[] = [];
  for (const block of flow.blocks) {
    for (const [at, part] of block.parts.entries()) {
      if (at > 0 && part.page !== block.parts[at - 1]!.page) joinedPages.push(part.page);
    }
  }
  if (rows.length === shelved.length) {
    /*
     * COUNTED AGAINST THE FLOW AND NOT AGAINST THE FILE, which changed with the
     * shelf. Every block the model answered is a row now, so a book whose every
     * block was page furniture produces a file full of rows and no book at all —
     * and the check that asked whether there were any rows would happily have
     * written it.
     */
    throw new BookRunError(
      `${readingsPath} parsed, but nothing in it is text a book is made of — every block was page `
      + 'furniture or was struck. There is no book to write.',
    );
  }

  const images = await cutFigures(rows, readingsPath, cutFrom, opts);

  /*
   * WRITTEN ATOMICALLY: a temp file beside the target, then a rename (§2 of the
   * contract). Beside it rather than in the system temp directory because a
   * rename is only atomic within one filesystem, and the one guarantee this is
   * bought for — a crash leaves the old book or none, never half of one — is
   * exactly what a cross-device copy would give away.
   */
  const resolved = path.resolve(opts.outPath);
  ensureDir(path.dirname(resolved));
  const pending = `${resolved}.tmp`;
  /*
   * THE FIGURES MARKER IS ADDED HERE AND NOT IN `bookFile`, because it is a fact
   * about a stage that runs after the rows are minted: `cutFigures` is what knows
   * whether there was anything to cut from and whether the pixels landed. The
   * whole argument for the field is in `BookFigures`; the short version is that
   * a book made with nothing to cut from used to be indistinguishable on disk
   * from a book with no pictures, and that silence is what let Owen's captured
   * book sit unexportable for a month.
   */
  const figures: BookFigures = {
    blocks: rows.filter((row) => row.category === 'Picture' && row.shelf === undefined).length,
    cut: images.length,
    from: cutFrom === null ? null : cutFrom.kind,
  };
  fs.writeFileSync(pending, formatBookFile({ ...book, figures }), 'utf8');
  fs.renameSync(pending, resolved);

  opts.log(
    `vlm-book: ${rows.length - shelved.length} block(s) from ${parsed.length} page(s) — `
    + `${joinedPages.length} paragraph(s) joined across a page turn, `
    + `${flow.reflowed.length} reflowed out of print lines, `
    + `${flow.mergedHeadings.length} heading(s) merged out of two boxes, `
    + `${flow.promotedHeadings.length} heading(s) the contents page lists, promoted to chapter `
    + 'openings, '
    + `${flow.adoptedNotes.length} list item(s) adopted as footnotes, `
    + `${flow.suppressedHeads.length} running head(s) dropped`
    + (unreadable.length === 0 ? '' : `, ${unreadable.length} page(s) UNREADABLE`),
  );
  /*
   * The shelf, tallied — and it is a line of its own rather than a clause of the
   * one above, because it says something the counts up there cannot. Those are a
   * description of the book; this is a description of what is NOT in the book and
   * is still in the file, which is the whole promise of §5. A person who thinks
   * the run lost thirty-six blocks can go and look at thirty-six rows.
   */
  if (shelved.length > 0) {
    const heads = shelved.filter((row) => row.shelf === 'suppressed-head').length;
    opts.log(
      `vlm-book: ${shelved.length} block(s) shelved — ${shelved.length - heads} furniture, `
      + `${heads} suppressed heads. They are rows of the file at their reading-order position, each `
      + 'with a sentence saying why, and restoring one is an op against its id.',
    );
  }
  /*
   * The apparatus, counted — and the two failures are counted BESIDE the
   * success rather than instead of it, because either number alone is
   * unreadable. "12 markers linked" says nothing about whether that is all of
   * them; "3 markers with no note" says nothing about whether the matcher is
   * working at all. Together they are the shape of the book's apparatus in one
   * line, and both failures are the LINKING flags the renderer will draw in the
   * margin — structural facts about what the printer set, not suspicion about
   * the scan.
   */
  const linked = rows.reduce((sum, row) => sum + (row.refs?.length ?? 0), 0);
  opts.log(
    `vlm-book: ${linked} reference marker(s) linked, `
    + `${book.loose.markers.length} marker(s) with no note, `
    + `${book.loose.notes.length} note(s) nothing points at`,
  );
  if (flow.unjoinedTurns.length > 0) {
    opts.log(
      `vlm-book: ${flow.unjoinedTurns.length} page turn(s) left as two paragraphs `
      + `(p${flow.unjoinedTurns.join(', p')}). The words do not say the paragraph carried on and `
      + 'nothing here reads the page to guess. Join them by hand where the book wanted them joined '
      + '— this file is the one that keeps the answer.',
    );
  }
  opts.log(`vlm-book: wrote ${resolved}`);

  return {
    rows,
    unreadable,
    joinedPages,
    unjoinedTurns: flow.unjoinedTurns,
    reflowed: flow.reflowed.length,
    shelved: {
      furniture: shelved.length - shelved.filter((row) => row.shelf === 'suppressed-head').length,
      suppressedHeads: shelved.filter((row) => row.shelf === 'suppressed-head').length,
    },
    images,
  };
}

/**
 * The crops directory, emptied — with a short ladder for the case where
 * something outside this program is holding a file in it.
 *
 * ── DEFENCE IN DEPTH. THIS IS NOT THE FIX FOR ANYTHING ──────────────────────
 *
 * Read this before you conclude that a retry was the answer to the EBUSY a user
 * hit on 2026-08-19, because it was not, and mistaking it for one is how the
 * real defect gets reintroduced. That EBUSY came from TWO COPIES OF THIS RUN
 * over one book: the app spawned a second `vlm-book` while the first was still
 * writing crops here, the second reached this rm, and Windows refused to unlink
 * a file the first process had open. The lock was the app's own. It was fixed
 * where it belonged — one writer per book file, in the app's `writeBookFile`
 * (app/electron/engine.ts) — and a retry alone would have made it WORSE rather
 * than better: the second run would simply have won the directory a few hundred
 * milliseconds later and deleted crops the first run had finished, leaving a
 * book that names plates which are not on the disk and no error anywhere.
 *
 * ── So what this IS for ─────────────────────────────────────────────────────
 *
 * A holder that is genuinely not us, which is a real and ordinary thing on the
 * machines this runs on: an antivirus scanner reading a PNG it just saw
 * appear, a shell preview handler that opened a thumbnail because the folder is
 * in view, a network share that has not yet released a handle. Every one of
 * those lets go within a second or so, and every one of them would otherwise
 * fail a reflow outright over a directory whose whole content is regenerable.
 * That is what the ladder buys and it is all it buys.
 *
 * ALREADY GONE IS SUCCESS — the ordinary first run, where there is nothing here
 * to clear. `force` says so to `rmSync` and the `ENOENT` arm says so again for
 * anything that vanishes underneath the recursive walk.
 *
 * AND THE LAST FAILURE IS STILL A FAILURE, in this run's own words rather than
 * as a raw errno out of the middle of a stage. Going on would cut fresh crops
 * into a directory still holding the ones this run was supposed to replace,
 * which is exactly the stale-figure-under-a-new-name hazard the rm exists to
 * prevent.
 */
async function clearStaleCrops(cropsDir: string, log: (line: string) => void): Promise<void> {
  /* Four waits, a second and a half in total. Long enough for a scanner to
     finish with one file; short enough that a directory somebody has a real and
     lasting lock on is reported rather than waited on. */
  const backoff = [50, 150, 400, 900];
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(cropsDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      const held = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      const wait = backoff[attempt];
      if (!held || wait === undefined) {
        throw new BookRunError(
          `${cropsDir} could not be emptied before the figures were cut `
          + `(${code ?? (err as Error).message}). Something is holding a file in it. The figures in `
          + 'this book would otherwise be a mixture of this run and the last one, so the run stops '
          + 'here rather than writing a book whose plates cannot be accounted for.',
        );
      }
      log(`vlm-book: ${cropsDir} is held by something else (${code}); waiting ${wait}ms to try again`);
      await new Promise((wake) => { setTimeout(wake, wait); });
    }
  }
}

/**
 * The figures, cut out of the archived original once — §6 of the contract.
 *
 * ── WHY THE CROPS MOVED HERE, OUT OF THE EPUB WRITER ────────────────────────
 *
 * They used to be cut inside `buildDotsBook`, while a container was being
 * zipped, because that is where the only consumer was. The consequence was that
 * a picture existed only inside an export: casting the same book as text cut
 * nothing, casting it twice cut everything twice, and an editing surface that
 * wanted to SHOW somebody a figure had no file to point at and no way to make
 * one without emitting a book. The book file is the document everything reads
 * now, so the pixels are cut where the document is made, named after the
 * coordinate the row was minted at, and every later reader — the renderer, an
 * export, whatever comes after them — opens the same PNG.
 *
 * ONLY THE PAGES THAT CARRY A PICTURE ARE OPENED. The crop mode of
 * `vlm_page.py` takes a pixmap per named box — rasterising that leaf of the PDF,
 * or decoding that one photograph — so a book with four figures pays for four
 * pages however long it is, which is what makes this affordable in a command
 * whose whole promise is that it is instant.
 *
 * EITHER FACE, AND THE ROWS CANNOT TELL. `--pdf` is a document to rasterise and
 * `--pages` is the photographs a capture project made; the box means the frame
 * of the page render either way (that is what the bank records), so the crop is
 * the same rectangle of the same page and lands under the same name. The helper
 * carries the geometry of both, side by side, in `run_crop`.
 *
 * WITH NO SOURCE IT CUTS NOTHING AND SAYS SO, once, in a sentence that names the
 * reason and both flags. There is no fallback available and none would be wanted:
 * the pixels are in the pages or they are nowhere, and an imported EPUB has no
 * pages to cut at all. A row simply has no `image` — and since Wave 37 the
 * HEADER says so too, because a row that lacks a field is not evidence anybody
 * downstream could act on (`BookFigures`).
 *
 * THE DIRECTORY IS MADE FRESH. It is derived, regenerable and swept with the
 * book file, and a regeneration after the join rule improved must not leave the
 * crop of a figure that is now named something else sitting beside the one that
 * is. Deleting it is safe for the same reason writing it is: nothing in it was
 * anybody's labour. `clearStaleCrops` is that delete and carries the one thing
 * worth knowing about it — a retry that is defence against an outside holder and
 * is emphatically NOT the fix for two runs racing each other.
 */
async function cutFigures(
  rows: readonly BookRow[],
  readingsPath: string,
  source: VlmSource | null,
  opts: BookRunOptions,
): Promise<string[]> {
  // A shelved row is not in the book, and the shelf holds no pictures anyway —
  // furniture is a header or a footer and a suppressed head is a heading.
  const pictures = rows.filter((row) => row.category === 'Picture' && row.shelf === undefined);
  if (source === null) {
    if (pictures.length > 0) {
      opts.log(
        `vlm-book: ${pictures.length} figure(s) were NOT cut — this run was given no pages, and a `
        + 'figure is pixels out of the page it was printed on. The rows name no image; pass --pdf '
        + 'for a scanned document or --pages for the photographs the book was read from, and they '
        + 'are cut in seconds.',
      );
    }
    return [];
  }

  const cropsDir = imagesDir(readingsPath);
  await clearStaleCrops(cropsDir, opts.log);
  ensureDir(cropsDir);
  if (pictures.length === 0) {
    opts.log(`vlm-book: no Picture block in this book, so ${cropsDir} is empty`);
    return [];
  }

  const requests: DotsCrop[] = pictures.map((row) => ({
    page: row.page,
    box: row.box,
    name: figureName(row.parts[0]!.src),
  }));
  /*
   * Through `openPageImages`, which is the seam the assembler already reaches
   * for pixels through (`dots-book.ts`). It forwards one function and is worth
   * going through anyway: everything on this side of it is arithmetic over
   * banked answers, and everything past it is a subprocess. One boundary, one
   * place a run stops being pure.
   */
  const images = openPageImages((crops) => cropPageRenders({
    source,
    dpi: VLM_DPI,
    cropsDir,
    requests: crops.map((crop) => ({ page: crop.page, box: crop.box, name: crop.name })),
    ...(opts.python !== undefined ? { python: opts.python } : {}),
  }));
  const cropped = await images.crop(requests);
  if (cropped.length !== requests.length) {
    throw new BookRunError(
      `${requests.length} figure(s) were asked for and ${cropped.length} came back. A row naming an `
      + 'image that is not there is a broken picture in every reader of this book.',
    );
  }
  // The name goes on the row only once the pixels are on the disk: a book file
  // that pointed at a figure a failed crop never wrote would be a document
  // making a promise about a file, and the file is the promise.
  for (const [index, row] of pictures.entries()) row.image = requests[index]!.name;
  opts.log(
    `vlm-book: ${cropped.length} figure(s) cut into ${cropsDir}, out of ${sourceName(source)}`,
  );
  return requests.map((request) => request.name);
}
