#!/usr/bin/env bun
/**
 * pgm-to-pdf — build a SCANNED PDF out of page renders.
 *
 *   bun run tools/pgm-to-pdf.ts <out.pdf> <page.pgm> [page.pgm …]
 *
 * A developer tool, and it exists for one reason: foundry does not rasterize
 * PDFs (the renders come from BookForge's mupdf pool), so there is no way in
 * this repository to turn a real scanned book into the page images the scanned
 * path needs. This goes the other way. It takes renders the repository already
 * has — `fixtures/scan/pages/*.pgm`, real pages of real books at the pinned 200
 * dpi — and wraps them into a PDF that IS a scan: one grayscale image per page,
 * no text layer anywhere.
 *
 * That makes the scanned end-to-end run real rather than simulated. The PDF and
 * the renders are the same pixels by construction, so `foundry scan --pages`
 * and `foundry get-text --pdf` are looking at one book, and every stage after
 * them is doing exactly what it does on somebody's actual scan.
 *
 * Nothing about the image is transcoded: the PGM's bytes are the image data,
 * flate-compressed, at 8 bits per component in DeviceGray.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { PDFDocument, PDFName } from '@cantoo/pdf-lib';

import { readPgm } from '../src/scan/pgm.js';
import { OCR_DPI } from '../src/scan/tesseract.js';
import { POINTS_PER_INCH } from '../src/pdf/frame.js';

const [, , out, ...pages] = process.argv;
if (!out || pages.length === 0) {
  process.stderr.write('usage: bun run tools/pgm-to-pdf.ts <out.pdf> <page.pgm> [page.pgm …]\n');
  process.exit(2);
}

const doc = await PDFDocument.create();
const ctx = doc.context;

for (const source of pages) {
  const raster = readPgm(new Uint8Array(readFileSync(source)), source);
  const widthPt = (raster.width * POINTS_PER_INCH) / OCR_DPI;
  const heightPt = (raster.height * POINTS_PER_INCH) / OCR_DPI;

  const image = ctx.register(ctx.flateStream(raster.data, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: raster.width,
    Height: raster.height,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  }));

  const page = doc.addPage([widthPt, heightPt]);
  const resources = page.node.Resources()!;
  const xobjects = ctx.obj({});
  xobjects.set(PDFName.of('Im0'), image);
  resources.set(PDFName.of('XObject'), xobjects);
  // The image, scaled to the whole page. `cm` maps the image's unit square onto
  // the page, which is what puts one 200 dpi pixel on one 1/200 inch of paper.
  page.node.set(
    PDFName.of('Contents'),
    ctx.obj([ctx.register(ctx.flateStream(`q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Im0 Do\nQ\n`))]),
  );
  process.stderr.write(`  ${source}: ${raster.width}×${raster.height} px → ${widthPt.toFixed(1)}×${heightPt.toFixed(1)} pt\n`);
}

const bytes = await doc.save({ useObjectStreams: false });
writeFileSync(out, bytes);
process.stderr.write(`wrote ${out} — ${pages.length} pages, ${bytes.length} bytes\n`);
