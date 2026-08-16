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
 * NO PDF, NO RASTERISER, NO MODEL. A bank written by this version records the
 * render size and the pixel budget beside every answer, which is the entire
 * frame a box needs. A bank old enough to lack them is REFUSED BY NAME rather
 * than rendered again behind somebody's back: this command exists to be cheap
 * and instant, and one that quietly spawned a rasteriser over three hundred
 * pages would be neither.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import { bookRows, formatBookFile, type BookRow } from './book-file.js';
import { DotsPageError, parseDotsPage, type DotsParsedPage } from './dots.js';
import { reflowBook } from './dots-book.js';
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
}

export async function buildBookFile(opts: BookRunOptions): Promise<BookRunReport> {
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
  const rows = bookRows(flow);
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
  if (rows.length === 0) {
    throw new BookRunError(
      `${readingsPath} parsed, but nothing in it is text a book is made of — every block was page `
      + 'furniture or was struck. There is no book to write.',
    );
  }

  const resolved = path.resolve(opts.outPath);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, formatBookFile(rows), 'utf8');

  opts.log(
    `vlm-book: ${rows.length} block(s) from ${parsed.length} page(s) — `
    + `${joinedPages.length} paragraph(s) joined across a page turn, `
    + `${flow.reflowed.length} reflowed out of print lines, `
    + `${flow.mergedHeadings.length} heading(s) merged out of two boxes, `
    + `${flow.suppressedHeads.length} running head(s) dropped`
    + (unreadable.length === 0 ? '' : `, ${unreadable.length} page(s) UNREADABLE`),
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
  };
}
