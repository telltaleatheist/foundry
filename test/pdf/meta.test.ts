/**
 * The Info dictionary, round-tripped — and the pages proved to be untouched.
 *
 * This command is the one place in foundry that rewrites a whole PDF instead of
 * splicing one, so the assertion that earns it the right to do that is here:
 * after a metadata edit, every page's content stream comes back BYTE-IDENTICAL.
 * pdf-lib renumbers objects and rebuilds the cross-reference table, which is
 * fine and invisible; what would not be fine is the drawn content coming out
 * re-encoded, because in a book that is the book.
 *
 * The other half is what is NOT written. pdf-lib stamps its own `Producer` and
 * a fresh `ModDate` over a document's given half a chance, and a command whose
 * whole purpose is to write exactly the fields it was given must not quietly
 * write two it was not — so `Producer` is asserted to be the string the source
 * document carried, not the string pdf-lib would have put there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PDFArray, PDFDocument, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';

import { UsageError } from '../../src/args.js';
import { findCommand, runCommand } from '../../src/commands.js';
import { pdfMeta, PdfMetaError } from '../../src/pdf/meta.js';

const quiet = (): void => {};

/**
 * A two-page document with words on it, a title and an author.
 *
 * `Producer` is set to something no library would ever choose, because the
 * whole point of one assertion below is that it comes back saying exactly this
 * rather than "pdf-lib (https://github.com/Hopding/pdf-lib)".
 */
async function sourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const words of ['Seite eins', 'Seite zwei']) {
    const page = doc.addPage([300, 400]);
    page.drawText(words, { x: 40, y: 340, size: 18, font });
  }
  doc.setTitle('Der alte Titel');
  doc.setAuthor('Ein Verfasser');
  doc.setProducer('a scanner from 1998');
  return doc.save();
}

/** Every content stream of a page, as raw bytes. */
function pageContent(doc: PDFDocument, index: number): number[] {
  const contents = doc.getPage(index).node.Contents();
  assert.ok(contents !== undefined, `page ${index} has no content at all`);
  const out: number[] = [];
  const push = (value: unknown): void => {
    const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
    assert.ok(stream instanceof PDFRawStream, 'a content stream came back as something else');
    out.push(...stream.getContents());
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) push(contents.get(i));
  } else {
    push(contents);
  }
  return out;
}

interface Bench {
  dir: string;
  pdf: string;
  out: string;
  clean: () => void;
}

async function bench(): Promise<Bench> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pdfmeta-'));
  const pdf = path.join(dir, 'Buch.pdf');
  fs.writeFileSync(pdf, await sourcePdf());
  return {
    dir,
    pdf,
    out: path.join(dir, 'Buch.edited.pdf'),
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading
// ═════════════════════════════════════════════════════════════════════════════

test('reading the Info dictionary writes nothing and needs no --out', async () => {
  const b = await bench();
  try {
    const report = await pdfMeta({ pdfPath: b.pdf, set: {}, log: quiet });
    assert.equal(report.written, false);
    assert.equal(report.metadata.title, 'Der alte Titel');
    assert.equal(report.metadata.author, 'Ein Verfasser');
    assert.equal(report.metadata.subject, null);
    assert.equal(report.metadata.keywords, null);
    assert.equal(report.metadata.producer, 'a scanner from 1998');
    assert.equal(report.metadata.pages, 2);
    assert.equal(fs.existsSync(b.out), false);
  } finally {
    b.clean();
  }
});

test('--json prints the dictionary on stdout', async () => {
  const b = await bench();
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as never;
  try {
    await runCommand(findCommand('pdf-meta')!, ['--pdf', b.pdf, '--json']);
  } finally {
    process.stdout.write = write;
    b.clean();
  }
  const parsed = JSON.parse(chunks.join('')) as {
    version: number; kind: string; written: boolean; fields: Record<string, unknown>;
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.kind, 'pdf');
  assert.equal(parsed.written, false);
  assert.equal(parsed.fields['title'], 'Der alte Titel');
  assert.equal(parsed.fields['keywords'], null);
  assert.equal(parsed.fields['pages'], 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// Writing
// ═════════════════════════════════════════════════════════════════════════════

test('the four fields round-trip, and the pages come back byte-identical', async () => {
  const b = await bench();
  try {
    const report = await pdfMeta({
      pdfPath: b.pdf,
      outPath: b.out,
      set: {
        title: 'Working Towards the Führer',
        author: 'Ian Kershaw',
        subject: 'Nazi Germany, 1933–1945',
        keywords: 'germany, history, 1933',
      },
      log: quiet,
    });
    assert.equal(report.written, true);

    const after = await PDFDocument.load(new Uint8Array(fs.readFileSync(b.out)), { updateMetadata: false });
    assert.equal(after.getTitle(), 'Working Towards the Führer');
    assert.equal(after.getAuthor(), 'Ian Kershaw');
    assert.equal(after.getSubject(), 'Nazi Germany, 1933–1945');
    // Verbatim, commas and all: PDF has never standardised a separator, so
    // pdf-lib's list-joining is routed around rather than obeyed.
    assert.equal(after.getKeywords(), 'germany, history, 1933');

    /*
     * WHAT WAS NOT ASKED FOR WAS NOT WRITTEN. `updateMetadata: false` is the
     * only thing standing between this command and a scan whose Producer names
     * a JavaScript library — a document quietly signed by something that did
     * not make it.
     */
    assert.equal(after.getProducer(), 'a scanner from 1998');

    // And the book itself. Page count first, so a failure says which of the
    // two things went wrong, then the bytes.
    const before = await PDFDocument.load(new Uint8Array(fs.readFileSync(b.pdf)), { updateMetadata: false });
    assert.equal(after.getPageCount(), before.getPageCount());
    for (let i = 0; i < before.getPageCount(); i += 1) {
      assert.deepEqual(
        pageContent(after, i),
        pageContent(before, i),
        `page ${i + 1}'s content stream was re-encoded by a metadata edit`,
      );
    }

    // The input is never written to.
    const untouched = await PDFDocument.load(new Uint8Array(fs.readFileSync(b.pdf)), { updateMetadata: false });
    assert.equal(untouched.getTitle(), 'Der alte Titel');
  } finally {
    b.clean();
  }
});

test('only the fields given move; the rest of the dictionary stands', async () => {
  const b = await bench();
  try {
    const report = await pdfMeta({ pdfPath: b.pdf, outPath: b.out, set: { subject: 'Ein Thema' }, log: quiet });
    assert.deepEqual(report.changes, [
      { field: 'subject', from: null, to: 'Ein Thema', created: true },
    ]);
    const after = await PDFDocument.load(new Uint8Array(fs.readFileSync(b.out)), { updateMetadata: false });
    assert.equal(after.getTitle(), 'Der alte Titel');
    assert.equal(after.getAuthor(), 'Ein Verfasser');
    assert.equal(after.getSubject(), 'Ein Thema');
  } finally {
    b.clean();
  }
});

test('a field given the value it already holds writes no file at all', async () => {
  const b = await bench();
  try {
    const report = await pdfMeta({
      pdfPath: b.pdf,
      outPath: b.out,
      set: { title: 'Der alte Titel' },
      log: quiet,
    });
    assert.equal(report.written, false);
    assert.deepEqual(report.unchanged, ['title']);
    assert.equal(fs.existsSync(b.out), false);
  } finally {
    b.clean();
  }
});

test('running the same edit twice is idempotent', async () => {
  const b = await bench();
  try {
    await pdfMeta({ pdfPath: b.pdf, outPath: b.out, set: { title: 'Neu' }, log: quiet });
    const second = path.join(b.dir, 'again.pdf');
    const report = await pdfMeta({ pdfPath: b.out, outPath: second, set: { title: 'Neu' }, log: quiet });
    assert.equal(report.written, false);
    assert.deepEqual(report.changes, []);
  } finally {
    b.clean();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Every refusal
// ═════════════════════════════════════════════════════════════════════════════

test('--out equal to --pdf is refused, at the argv layer and in the engine', async () => {
  const b = await bench();
  try {
    await assert.rejects(
      () => runCommand(findCommand('pdf-meta')!, ['--pdf', b.pdf, '--out', b.pdf, '--title', 'X']),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /is the input itself/);
        return true;
      },
    );
    // Again through the engine door, for a caller that is not the CLI.
    await assert.rejects(
      () => pdfMeta({ pdfPath: b.pdf, outPath: b.pdf, set: { title: 'X' }, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof PdfMetaError);
        assert.match(error.message, /is the input itself/);
        return true;
      },
    );
  } finally {
    b.clean();
  }
});

test('setting a field with no --out is refused', async () => {
  const b = await bench();
  try {
    await assert.rejects(
      () => pdfMeta({ pdfPath: b.pdf, set: { title: 'X' }, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof PdfMetaError);
        assert.match(error.message, /--out says where the edited PDF is written/);
        return true;
      },
    );
  } finally {
    b.clean();
  }
});

test('an empty value is refused rather than blanking the entry', async () => {
  const b = await bench();
  try {
    await assert.rejects(
      () => pdfMeta({ pdfPath: b.pdf, outPath: b.out, set: { author: '  ' }, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof PdfMetaError);
        assert.match(error.message, /--author was given an empty value/);
        return true;
      },
    );
  } finally {
    b.clean();
  }
});

test('a --pdf that cannot be read is refused by name', async () => {
  await assert.rejects(
    () => pdfMeta({ pdfPath: path.join(os.tmpdir(), 'foundry-no-such-scan.pdf'), set: {}, log: quiet }),
    (error: unknown) => {
      assert.ok(error instanceof PdfMetaError);
      assert.match(error.message, /cannot be read/);
      assert.match(error.message, /foundry-no-such-scan\.pdf/);
      return true;
    },
  );
});

test('a file that is not a PDF is refused by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pdfmeta-bad-'));
  try {
    const notPdf = path.join(dir, 'Buch.pdf');
    fs.writeFileSync(notPdf, 'this is not a PDF at all\n');
    await assert.rejects(
      () => pdfMeta({ pdfPath: notPdf, set: {}, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof PdfMetaError);
        assert.match(error.message, /could not be opened as a PDF/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
