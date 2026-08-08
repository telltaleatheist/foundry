/**
 * vlm/pages — which pages of the PDF this run is about, and which it is not.
 *
 * `--skip-pages 3,17,19-24` is how a CURATED book reaches this mode. Somebody
 * has opened the PDF in a picker and decided that the scanner's colour card,
 * the publisher's blank leaf and six pages of a foreign-language appendix are
 * not part of the book they want narrated, and the conversion has to agree
 * with them.
 *
 * IT IS A SKIP, NOT A SUBSET, and that is the whole design. The obvious
 * alternative — write a new PDF with those pages physically removed and
 * convert that — changes the file's sha256, and the sha256 is the document's
 * IDENTITY: it is what the readings cache is keyed to (`readings.ts`), what
 * names the cache directory, and what BookForge tracks the document by. A
 * curation that silently invalidated an hour of banked GPU answers would be a
 * curation nobody could afford to change their mind about. So the pages are
 * skipped in place, the file is untouched, and every page that survives keeps
 * its TRUE PDF page number — `data-bf-page` on page 25 says 25, whatever was
 * struck out in front of it.
 *
 * THE REFUSALS ARE SPLIT, along the line of who knows the fact. This module
 * knows the SYNTAX: a page that is not a number, a page 0, a range that runs
 * backwards. Only `vlm_page.py` knows how many pages the document has, so
 * "page 500 of a 300-page document" and "every page of the book" are refused
 * THERE — before a model is loaded and before a page is rendered. Neither
 * refusal exists twice, and neither is a guess.
 *
 * A bad `--skip-pages` is a wrong COMMAND LINE, so it throws `UsageError` and
 * the process exits 2 with nothing run (see the header of `src/cli.ts`).
 */
import { UsageError } from '../args.js';

/**
 * A range is EXPANDED here, so it has to be bounded before it is.
 * `--skip-pages 1-999999999` is a typo, and the honest answer to a typo is a
 * message rather than a program that appears to have hung. This is two orders
 * of magnitude past the longest book anybody has put through this mode; the
 * real bound — the document's own page count — is applied by `vlm_page.py`.
 */
const MAX_RANGE = 100_000;

/**
 * `3,17,19-24` → `[3, 17, 19, 20, 21, 22, 23, 24]`, sorted, no duplicates.
 *
 * `option` is the flag's own spelling, so the message names what the reader
 * typed rather than what this function is called.
 */
export function parsePageList(raw: string, option: string): number[] {
  if (raw.trim().length === 0) {
    throw new UsageError(`${option} was given no pages`);
  }

  const pages = new Set<number>();
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (entry.length === 0) {
      // A trailing comma, or two in a row. Named as what it is rather than as
      // an entry that does not parse: `does not understand ""` sends a reader
      // looking for a quoted empty string they never typed.
      throw new UsageError(`${option} has an empty entry in "${raw}"`);
    }

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(entry);
    if (range !== null) {
      const first = requirePage(Number(range[1]), option);
      const last = requirePage(Number(range[2]), option);
      if (last < first) {
        throw new UsageError(`${option} names the range ${entry}, which runs backwards`);
      }
      if (last - first + 1 > MAX_RANGE) {
        throw new UsageError(
          `${option} names the range ${entry}, which spans ${last - first + 1} pages. That is not`
          + ' a page range anybody typed on purpose.',
        );
      }
      for (let page = first; page <= last; page += 1) pages.add(page);
      continue;
    }

    if (!/^\d+$/.test(entry)) {
      throw new UsageError(
        `${option} does not understand "${entry}". It takes 1-based page numbers and ranges,`
        + ' comma separated: 3,17,19-24',
      );
    }
    pages.add(requirePage(Number(entry), option));
  }

  return [...pages].sort((a, b) => a - b);
}

function requirePage(page: number, option: string): number {
  if (page >= 1) return page;
  throw new UsageError(`${option} names page ${page}, and a PDF's pages start at 1`);
}
