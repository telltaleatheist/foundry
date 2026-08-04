/**
 * The compiled-binary probe.
 *
 * Not a test by itself — `compile.test.ts` builds this file with
 * `bun build --compile` and runs the resulting executable. Everything foundry
 * added for the document pipeline that could plausibly fail inside a compiled
 * binary is exercised here, because the two dependencies it rests on both nearly
 * did:
 *
 *  - pdf.js needs `DOMMatrix` (which it obtains from a NATIVE package in Node)
 *    and loads its worker with a dynamic import (which is not bundled). Both
 *    are handled in `src/pdf/runtime.ts`, and neither failure is visible under
 *    `bun run` — only a real binary shows them.
 *  - @cantoo/pdf-lib is pure JavaScript and was expected to be fine. "Expected"
 *    is not the standard: it writes the document, so it is proven too.
 *
 * Prints one line of JSON. The test reads it.
 */
import { PDFDocument } from '@cantoo/pdf-lib';

import { extractDocument } from '../../src/pdf/extract.js';
import { frameFromPage } from '../../src/pdf/frame.js';
import { writeTextLayer } from '../../src/pdf/textlayer.js';

const LINES = [
  { text: 'Working Towards the Führer', box: [200, 300, 1200, 340] as [number, number, number, number] },
  { text: 'the treaty col—lapsed “quietly”, ﬁnally', box: [200, 380, 1500, 416] as [number, number, number, number] },
];

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const frame = frameFromPage(0, 612, 792, 200);
writeTextLayer(doc, page.node, frame, LINES);
const bytes = await doc.save();

const extracted = await extractDocument(bytes, { dpi: 200 });
process.stdout.write(`${JSON.stringify({
  bytes: bytes.length,
  pages: extracted.pages.length,
  lines: extracted.pages[0]?.lines.map(l => l.text) ?? [],
})}\n`);
