/**
 * Fixtures for the PDF spike.
 *
 * Two kinds, and the split is deliberate:
 *
 *  - **Synthesized**, built here by pdf-lib. Always available, so the spike's
 *    scale test (hundreds of pages, hundreds of appends) is part of every run
 *    of the suite rather than something that only happens on one machine.
 *  - **Real books**, in `fixtures/local/`, which is git-ignored — a 41 MB scan
 *    of somebody's copyrighted history book has no business in this repository.
 *    Tests over them SKIP when the file is not there and say so, because a
 *    spike whose only evidence is a synthetic document has not been run against
 *    the thing it is about.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

export const LOCAL_FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'local');

/** A real scanned book, 3.6 MB. Absent unless someone put it there. */
export const KERSHAW_SMALL = join(LOCAL_FIXTURES, 'kershaw-fuhrer.pdf');
/** A real book, 41 MB — the size case. */
export const KERSHAW_LARGE = join(LOCAL_FIXTURES, 'kershaw-hitler-myth.pdf');

export const hasLocal = (path: string): boolean => existsSync(path);

/**
 * A multi-hundred-page PDF with real content on every page.
 *
 * Text rather than empty pages: an empty page is a smaller object graph than
 * any book has, and the thing being measured is what repeated incremental
 * updates do to a file with a real cross-reference table in it.
 */
export async function synthesizeBook(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.setFont(font);
    page.drawText(`Page ${i + 1}`, { x: 72, y: 720, size: 18 });
    for (let line = 0; line < 30; line++) {
      page.drawText(
        `The treaty collapsed in the spring of ${1900 + (i % 40)}, line ${line + 1} of page ${i + 1}.`,
        { x: 72, y: 680 - line * 16, size: 11 },
      );
    }
  }
  return doc.save();
}
