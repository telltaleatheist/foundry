/**
 * Keeper: a damaged PDF is rebuilt into working/, and archive/ keeps the original
 * bytes (Owen, 2026-11-08).
 *
 *   bun test packages/foundry-core/test/lib/pdf-repair.test.ts
 *
 * A scan opened as "This PDF would not open — Page dictionary kid reference points
 * to wrong type of object": wrong xref offsets, and five of its 388 page-tree
 * entries pointing at objects that are not in the file. pdf.js read 120 entries and
 * threw at the first missing one; MuPDF repaired the xref and read the 383 pages.
 *
 * The fixtures are written here, byte by byte, so the damage is on the page: four
 * entries under /Pages where the second is MISSING from the file, with every xref
 * offset wrong (the real file's shape: pdf.js throws exactly that sentence on it),
 * and where the second is a FONT (which pdf.js draws as a blank page, and MuPDF
 * counts as one).
 *
 * Fails on main: `pdf-repair.ts` did not exist, the import copied the damaged
 * scan into working/ as it was, and `document:read-bytes` handed it to pdf.js.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { readDocumentBytes } from '../../src/node/doors-library';
import { admit } from '../../src/node/openable';
import { checkPdf, healWorkingPdf, isWorkingPdf, onPdfNotice } from '../../src/node/pdf-repair';
import { importDocument } from '../../src/node/projects-import';
import { useTestPlatform } from './platform-fixture';

const PAGE_WORDS = ['first page', 'second page', 'third page'];

/**
 * Three text pages under a tree whose second entry is not a page: object 10, which
 * the file does not have (`missing`), or the font (`font`). With `wrongOffsets`,
 * every xref entry points 7 bytes early and startxref is wrong too.
 */
function damagedTree(fault: 'missing' | 'font', wrongOffsets: boolean): Buffer {
  const second = fault === 'missing' ? '10 0 R' : '6 0 R';
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${second} 4 0 R 5 0 R] /Count 4 >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...PAGE_WORDS.map((words) => {
      const stream = `BT /F1 18 Tf 20 100 Td (${words}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const shift = wrongOffsets ? 7 : 0;
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at - shift).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt - shift}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function soundPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

type Mupdf = typeof import('mupdf');
const mupdf: Mupdf = await import('mupdf');

/** The words on each page as MuPDF reads them, and whether reading it needed a repair. */
function readBack(bytes: Uint8Array): { words: string[]; repaired: boolean } {
  const doc = new mupdf.PDFDocument(bytes);
  const words: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    words.push(doc.loadPage(i).toStructuredText().asText().trim());
  }
  return { words, repaired: doc.wasRepaired() };
}

let root = '';
let library = '';

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-pdf-repair-'));
  const userData = path.join(root, 'userData');
  library = path.join(root, 'library');
  await fsp.mkdir(userData, { recursive: true });
  await fsp.writeFile(path.join(userData, 'app-settings.json'), JSON.stringify({ libraryDir: library }));
  useTestPlatform((name) => (name === 'userData' ? userData : path.join(root, name)));
});

afterAll(async () => {
  onPdfNotice(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

test('a page tree with a font among its pages is rebuilt, every page kept in order', async () => {
  const health = await checkPdf(damagedTree('font', false));
  expect(health.state).toBe('rebuilt');
  if (health.state !== 'rebuilt') return;
  expect(health.pages).toBe(3);
  // MuPDF lists the font as a fourth page; grafted, it would be a blank page in the book.
  expect(health.dropped).toEqual([2]);
  expect(health.why).toContain('page tree');
  expect(health.why).toContain('/Font');
  const back = readBack(health.bytes);
  expect(back.words).toEqual(PAGE_WORDS);
  expect(back.repaired).toBe(false);
  expect(await checkPdf(health.bytes)).toEqual({ state: 'sound', pages: 3 });
});

test('the real file shape: wrong xref, an entry missing from the file; rebuilt without it, both damages named', async () => {
  const health = await checkPdf(damagedTree('missing', true));
  expect(health.state).toBe('rebuilt');
  if (health.state !== 'rebuilt') return;
  expect(health.pages).toBe(3);
  expect(health.dropped).toEqual([2]);
  expect(health.why).toContain('cross-reference');
  expect(health.why).toContain('entry 2 of the page tree is missing from the file');
  expect(readBack(health.bytes).words).toEqual(PAGE_WORDS);
});

test('a sound PDF is left alone, and bytes that are no PDF are unrepairable with a reason', async () => {
  expect(await checkPdf(await soundPdf(2))).toEqual({ state: 'sound', pages: 2 });
  const junk = await checkPdf(Buffer.from('this is not a pdf at all'));
  expect(junk.state).toBe('unrepairable');
  if (junk.state === 'unrepairable') expect(junk.why.length).toBeGreaterThan(0);
});

test('an import rebuilds working/, keeps archive/ byte for byte, and says so in one sentence', async () => {
  const told: string[] = [];
  onPdfNotice((sentence) => told.push(sentence));
  const outside = path.join(root, 'outside', 'Damaged Scan. Somebody, A. (1993).pdf');
  await fsp.mkdir(path.dirname(outside), { recursive: true });
  const original = damagedTree('missing', true);
  await fsp.writeFile(outside, original);

  const imported = await importDocument(outside, 'pdf');
  const archived = await fsp.readFile(path.join(imported.dir, 'archive', path.basename(outside)));
  expect(archived.equals(original)).toBe(true);
  const working = path.join(imported.dir, ...imported.entry.split('/'));
  expect(isWorkingPdf(working)).toBe(true);
  expect(readBack(await fsp.readFile(working))).toEqual({ words: PAGE_WORDS, repaired: false });

  expect(imported.notice).not.toBeNull();
  expect(imported.notice).toContain('holds 3 pages, leaving out entry 2 of its page list');
  expect(imported.notice).toContain('archive/');
  expect(told).toEqual([imported.notice as string]);
  // The user's own file is never written.
  expect((await fsp.readFile(outside)).equals(original)).toBe(true);
});

test('a project imported before the fix is healed when its working PDF is opened, once', async () => {
  const told: string[] = [];
  onPdfNotice((sentence) => told.push(sentence));
  const dir = path.join(library, 'projects', 'old-import-1234abcd');
  const original = damagedTree('font', false);
  await fsp.mkdir(path.join(dir, 'archive'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'working'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'archive', 'Old.pdf'), original);
  const working = path.join(dir, 'working', 'Old.pdf');
  await fsp.writeFile(working, original);
  admit(working);

  const bytes = await readDocumentBytes(working);
  expect(readBack(bytes)).toEqual({ words: PAGE_WORDS, repaired: false });
  expect((await fsp.readFile(working)).equals(bytes)).toBe(true);
  expect((await fsp.readFile(path.join(dir, 'archive', 'Old.pdf'))).equals(original)).toBe(true);
  expect(told.length).toBe(1);
  expect(told[0]).toContain('Old.pdf was damaged');

  // Opened again, it is sound and nobody is told twice.
  await readDocumentBytes(working);
  expect(told.length).toBe(1);
});

test('archive/ is refused by name, and is never handed to the rebuild by the open door', async () => {
  const dir = path.join(library, 'projects', 'archive-only-5678abcd');
  await fsp.mkdir(path.join(dir, 'archive'), { recursive: true });
  const archived = path.join(dir, 'archive', 'Kept.pdf');
  const original = damagedTree('font', false);
  await fsp.writeFile(archived, original);
  expect(isWorkingPdf(archived)).toBe(false);
  expect(() => healWorkingPdf(archived)).toThrow('not this app\'s to rebuild');
  admit(archived);
  expect((await readDocumentBytes(archived)).equals(original)).toBe(true);
  expect((await fsp.readFile(archived)).equals(original)).toBe(true);
});
