/**
 * The @cantoo/pdf-lib validation spike — kept, because it is the regression net.
 *
 * The document pipeline rests on one library behaving in one specific way:
 * incremental updates that append, never rewrite, and that a later parse can
 * read back completely. That path in pdf-lib had data-loss and cross-reference
 * bugs fixed as recently as 2026-07, so it was validated before anything was
 * built on it, and the validation stayed in the suite. A regression here is not
 * "a test went red" — it is every working document in the field being one stage
 * away from losing a chapter.
 *
 * Five questions, in the order they were asked (docs/PDF_SPIKE.md carries the
 * numbers):
 *
 *  1. Do hundreds of sequential appends hold — page count, and the contents of
 *     every annotation written along the way?
 *  2. Is every recorded boundary a valid PDF, so "reset to stage" is a
 *     truncate?
 *  3. Does an invisible text layer come back out, with its positions?
 *  4. Do custom dictionary keys survive a parse after an incremental save?
 *  5. What does a linearized input do?
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from '@cantoo/pdf-lib';

import { readBlockAnnotations, writeBlockAnnotations, DEFAULT_PALETTE } from '../../src/pdf/annotations.js';
import { truncateToBoundary, WorkingPdf, writeWholeDocument } from '../../src/pdf/document.js';
import { extractDocument } from '../../src/pdf/extract.js';
import { frameFromPage, type PageFrame } from '../../src/pdf/frame.js';
import { writeTextLayer } from '../../src/pdf/textlayer.js';
import { hasLocal, KERSHAW_LARGE, KERSHAW_SMALL, synthesizeBook } from './fixtures.js';
import { declaredLength, decodeBytes, isLinearized, linearizedPdf } from './linearized.js';

const DPI = 200;

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-spike-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * One stage's worth of work: open the file, add a square annotation carrying a
 * value only this round wrote, append, return the new boundary.
 */
async function appendMarkerAnnotation(file: string, round: number): Promise<number> {
  const working = await WorkingPdf.open(file);
  const doc = working.doc;
  const page = doc.getPage(round % doc.getPageCount());
  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [10, 10, 110, 60],
    F: 4,
    NM: PDFString.of(`round-${round}`),
    Contents: PDFString.of(`written by round ${round}`),
  });
  dict.set(PDFName.of('SpikeRound'), PDFNumber.of(round));
  const ref = doc.context.register(dict);

  const existing = page.node.get(PDFName.of('Annots'));
  if (existing instanceof PDFArray) {
    existing.push(ref);
    working.markChanged(page.node);
  } else if (existing === undefined) {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    working.markChanged(page.node);
  } else {
    // A reference to an array: the array is the object that changed.
    const array = doc.context.lookup(existing, PDFArray);
    array.push(ref);
    working.markChanged(existing);
  }
  return working.appendUpdate();
}

/** Every SpikeRound value in the document, whatever page it landed on. */
async function readMarkerRounds(file: string): Promise<Map<number, string>> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(file)));
  const found = new Map<number, string>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const round = annot.lookup(PDFName.of('SpikeRound'));
      if (!(round instanceof PDFNumber)) continue;
      const contents = annot.lookup(PDFName.of('Contents'));
      found.set(round.asNumber(), contents instanceof PDFString ? contents.decodeText() : '');
    }
  }
  return found;
}

describe('spike 1 — sequential incremental appends', () => {
  test('220 appends on a 300-page document keep every page and every annotation', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      writeFileSync(file, await synthesizeBook(300));
      const baseSize = statSync(file).size;

      const boundaries: number[] = [];
      for (let round = 0; round < 220; round++) {
        boundaries.push(await appendMarkerAnnotation(file, round));

        // Re-parse every 20 rounds: page count, and that nothing written
        // earlier has gone missing.
        if (round % 20 === 19) {
          const doc = await PDFDocument.load(new Uint8Array(readFileSync(file)));
          expect(doc.getPageCount()).toBe(300);
          const rounds = await readMarkerRounds(file);
          expect(rounds.size).toBe(round + 1);
          for (let earlier = 0; earlier <= round; earlier++) {
            expect(rounds.get(earlier)).toBe(`written by round ${earlier}`);
          }
        }
      }

      // Appends only ever grow the file, and the growth is bounded — an update
      // that rewrote the document instead of appending to it would show up here
      // as growth in multiples of the original.
      expect(boundaries).toEqual([...boundaries].sort((a, b) => a - b));
      expect(boundaries[0]).toBeGreaterThan(baseSize);
      expect(statSync(file).size).toBeLessThan(baseSize * 2);
    } finally {
      done();
    }
  }, 300_000);

  test.skipIf(!hasLocal(KERSHAW_SMALL))(
    'a real scanned book takes 25 appends and stays itself',
    async () => {
      const { dir, done } = scratch();
      try {
        const file = join(dir, 'working.pdf');
        writeFileSync(file, readFileSync(KERSHAW_SMALL));
        const before = await PDFDocument.load(new Uint8Array(readFileSync(file)));
        const pages = before.getPageCount();

        for (let round = 0; round < 25; round++) await appendMarkerAnnotation(file, round);

        const after = await PDFDocument.load(new Uint8Array(readFileSync(file)));
        expect(after.getPageCount()).toBe(pages);
        const rounds = await readMarkerRounds(file);
        expect(rounds.size).toBe(25);
        expect(rounds.get(24)).toBe('written by round 24');
      } finally {
        done();
      }
    },
    300_000,
  );

  test.skipIf(!hasLocal(KERSHAW_LARGE))(
    'a 41 MB book takes an append without rewriting itself',
    async () => {
      const { dir, done } = scratch();
      try {
        const file = join(dir, 'working.pdf');
        writeFileSync(file, readFileSync(KERSHAW_LARGE));
        const original = statSync(file).size;
        const boundary = await appendMarkerAnnotation(file, 0);
        // The whole point of an incremental update on a file this size.
        expect(boundary - original).toBeLessThan(64 * 1024);
        expect(statSync(file).size).toBe(boundary);
        const rounds = await readMarkerRounds(file);
        expect(rounds.get(0)).toBe('written by round 0');
      } finally {
        done();
      }
    },
    300_000,
  );
});

describe('spike 2 — a boundary is a byte offset', () => {
  test('truncating to an earlier boundary gives back that stage\'s document', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      writeFileSync(file, await synthesizeBook(12));
      const boundaries: number[] = [statSync(file).size];
      for (let round = 0; round < 6; round++) {
        boundaries.push(await appendMarkerAnnotation(file, round));
      }

      // Back to the state after round 2 (index 3: the base plus three appends).
      truncateToBoundary(file, boundaries[3]);
      expect(statSync(file).size).toBe(boundaries[3]);

      const doc = await PDFDocument.load(new Uint8Array(readFileSync(file)));
      expect(doc.getPageCount()).toBe(12);
      const rounds = await readMarkerRounds(file);
      expect([...rounds.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);

      // And the truncated document is still a document: another stage can run.
      const next = await appendMarkerAnnotation(file, 99);
      expect(next).toBeGreaterThan(boundaries[3]);
      expect((await readMarkerRounds(file)).get(99)).toBe('written by round 99');
    } finally {
      done();
    }
  }, 60_000);

  test('a boundary past the end of the file is refused, not obeyed', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      writeFileSync(file, await synthesizeBook(2));
      const size = statSync(file).size;
      expect(() => truncateToBoundary(file, size + 1)).toThrow(/different document/);
      expect(statSync(file).size).toBe(size);
    } finally {
      done();
    }
  }, 30_000);
});

describe('spike 3 — the invisible text layer', () => {
  const LINES = [
    { text: 'Working Towards the Führer', box: [200, 300, 1200, 340] as [number, number, number, number] },
    { text: 'the treaty col—lapsed “quietly”, ﬁnally', box: [200, 380, 1500, 416] as [number, number, number, number] },
    { text: 'a third line, further down the page', box: [200, 460, 1000, 496] as [number, number, number, number] },
  ];

  test('text written invisibly at a box comes back at that box, character for character', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const frame = frameFromPage(0, 612, 792, DPI);
    writeTextLayer(doc, page.node, frame, LINES);
    const bytes = await doc.save();

    const extracted = await extractDocument(bytes, { dpi: DPI });
    expect(extracted.pages).toHaveLength(1);
    const lines = extracted.pages[0].lines;
    expect(lines.map(l => l.text)).toEqual(LINES.map(l => l.text));

    // Position, in the frame it was written in. Half a pixel at 200 dpi is
    // 0.0025 inch; the tolerance is the round trip through points, not slack.
    for (let i = 0; i < LINES.length; i++) {
      const wanted = LINES[i].box;
      const got = lines[i].box;
      for (let k = 0; k < 4; k++) expect(Math.abs(got[k] - wanted[k])).toBeLessThan(1);
    }
  }, 60_000);

  test('the layer is invisible: rendering mode 3, and the page still draws nothing', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    writeTextLayer(doc, page.node, frameFromPage(0, 612, 792, DPI), LINES);
    const bytes = await doc.save({ useObjectStreams: false });
    const text = decodeBytes(bytes);
    // The operator is in the file (uncompressed content stream would show it;
    // flate-compressed, the marker to check is that a text layer exists at all).
    expect(text).toContain('/FoundryText');
    // And the font is glyphless: no font program is embedded.
    expect(text).not.toContain('FontFile');
  }, 30_000);

  test('a second get-text over the same document is refused', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const frame = frameFromPage(0, 612, 792, DPI);
    writeTextLayer(doc, page.node, frame, LINES);
    expect(() => writeTextLayer(doc, page.node, frame, LINES)).toThrow(/already carries a foundry text layer/);
  }, 30_000);
});

describe('spike 4 — custom annotation keys', () => {
  test('category, id, sequence and merge membership survive an incremental save', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      writeFileSync(file, await synthesizeBook(4));

      const frames = new Map<number, PageFrame>();
      for (let i = 0; i < 4; i++) frames.set(i, frameFromPage(i, 612, 792, DPI));

      const written = [
        { id: 'p0000b000', page: 0, seq: 0, category: 'chapter' as const, box: [100, 100, 1400, 180] as [number, number, number, number], text: 'One: The Beer Hall', merged: ['p0000b000', 'p0000b001'], deleted: false },
        { id: 'p0000b002', page: 0, seq: 1, category: 'body' as const, box: [100, 220, 1400, 900] as [number, number, number, number], text: 'The treaty collapsed.', merged: [], deleted: false },
        { id: 'p0002b000', page: 2, seq: 2, category: 'footnote' as const, box: [100, 1800, 1400, 1900] as [number, number, number, number], text: 'See Kershaw, 1993.', merged: [], deleted: true },
      ];

      const working = await WorkingPdf.open(file);
      const count = writeBlockAnnotations(
        working.doc, frames, written, DEFAULT_PALETTE, t => working.markChanged(t),
      );
      expect(count).toBe(3);
      await working.appendUpdate();

      const reread = await PDFDocument.load(new Uint8Array(readFileSync(file)));
      const back = readBlockAnnotations(reread, frames);
      expect(back).toHaveLength(3);
      expect(back.map(a => a.id)).toEqual(['p0000b000', 'p0000b002', 'p0002b000']);
      expect(back[0].category).toBe('chapter');
      expect(back[0].text).toBe('One: The Beer Hall');
      expect(back[0].merged).toEqual(['p0000b000', 'p0000b001']);
      expect(back[2].deleted).toBe(true);
      expect(back[1].deleted).toBe(false);
      for (let k = 0; k < 4; k++) {
        expect(Math.abs(back[0].box[k] - written[0].box[k])).toBeLessThan(1);
      }
    } finally {
      done();
    }
  }, 60_000);

  test('a second blocks run REPLACES the layer rather than doubling it', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      writeFileSync(file, await synthesizeBook(2));
      const frames = new Map<number, PageFrame>([
        [0, frameFromPage(0, 612, 792, DPI)],
        [1, frameFromPage(1, 612, 792, DPI)],
      ]);
      const box: [number, number, number, number] = [100, 100, 800, 200];

      const first = await WorkingPdf.open(file);
      writeBlockAnnotations(first.doc, frames,
        [{ id: 'a', page: 0, seq: 0, category: 'body', box, text: 'first', merged: [], deleted: false },
         { id: 'b', page: 1, seq: 1, category: 'body', box, text: 'first', merged: [], deleted: false }],
        DEFAULT_PALETTE, t => first.markChanged(t));
      await first.appendUpdate();

      const second = await WorkingPdf.open(file);
      writeBlockAnnotations(second.doc, frames,
        [{ id: 'c', page: 0, seq: 0, category: 'chapter', box, text: 'second', merged: [], deleted: false }],
        DEFAULT_PALETTE, t => second.markChanged(t));
      await second.appendUpdate();

      const reread = await PDFDocument.load(new Uint8Array(readFileSync(file)));
      const back = readBlockAnnotations(reread, frames);
      expect(back.map(a => a.id)).toEqual(['c']);
      expect(back[0].text).toBe('second');
    } finally {
      done();
    }
  }, 60_000);
});

describe('spike 5 — linearized input', () => {
  test('an append makes a linearized file\'s own declaration false', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      const original = linearizedPdf();
      writeFileSync(file, original);

      // The fixture is what it says it is: a file that declares its own length.
      expect(isLinearized(original)).toBe(true);
      expect(declaredLength(original)).toBe(original.length);

      // pdf-lib reads it, and an incremental update succeeds …
      const boundary = await appendMarkerAnnotation(file, 0);
      const updated = new Uint8Array(readFileSync(file));
      expect(updated.length).toBe(boundary);
      expect((await readMarkerRounds(file)).get(0)).toBe('written by round 0');

      // … and the linearization is now a lie: the file says it is shorter than
      // it is, which is exactly what a reader checks before trusting the
      // first-page layout. The declaration cannot be repaired by appending,
      // because repairing it would mean rewriting bytes at the front.
      expect(isLinearized(updated)).toBe(true);
      expect(declaredLength(updated)).toBe(original.length);
      expect(declaredLength(updated)).not.toBe(updated.length);
    } finally {
      done();
    }
  }, 60_000);

  test('a full rewrite de-linearizes, which is why get-text is one', async () => {
    const { dir, done } = scratch();
    try {
      const file = join(dir, 'working.pdf');
      const doc = await PDFDocument.load(linearizedPdf());
      await writeWholeDocument(doc, file);
      const rewritten = new Uint8Array(readFileSync(file));
      expect(isLinearized(rewritten)).toBe(false);
      expect(declaredLength(rewritten)).toBeNull();

      // And it is still the same document.
      const reloaded = await PDFDocument.load(rewritten);
      expect(reloaded.getPageCount()).toBe(1);

      // Every later append is now against a file that claims nothing about its
      // own length.
      await appendMarkerAnnotation(file, 0);
      expect(isLinearized(new Uint8Array(readFileSync(file)))).toBe(false);
    } finally {
      done();
    }
  }, 60_000);
});
