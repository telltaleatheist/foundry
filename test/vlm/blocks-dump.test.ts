/**
 * The blocks of a banked reading, as the app will get them.
 *
 * One claim is worth more than all the others here and it is the only hard one:
 * THE IDS AND THE BOXES ARE THE ONES THE RENDERERS WILL SEE. A box only means
 * something in a frame, the frame comes from the render size and the pixel
 * budget together, and a dump that computed either of them differently from the
 * conversion would draw every outline a few per cent off — invisible until
 * somebody strikes the wrong paragraph. So the assertion is against
 * `parseDotsPage` itself rather than against numbers typed out here.
 *
 * The rest is what the command promises: furniture included, because a person
 * curating a page is looking at all of it; a page whose answer will not parse
 * reported by number instead of costing the other pages; and a bank with no
 * geometry in it refused with a sentence that says what to pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dumpBlocks, VlmBlocksError } from '../../src/vlm/blocks-dump.js';
import { buildDotsBook } from '../../src/vlm/dots-book.js';
import { parseDotsPage } from '../../src/vlm/dots.js';
import { parseOverlay } from '../../src/vlm/overlay.js';
import { VlmReadings } from '../../src/vlm/readings.js';

const RENDER = { width: 1300, height: 2112 };
const MAX_PIXELS = 11_289_600;

/** One page of dots.ocr's answer: a running head, a heading, a paragraph. */
const PAGE_ANSWER = JSON.stringify([
  { bbox: [560, 60, 740, 90], category: 'Page-header', text: 'NUREMBERG 42' },
  { bbox: [400, 200, 900, 300], category: 'Title', text: 'CHAPTER II' },
  { bbox: [200, 400, 1100, 900], category: 'Text', text: '# A heading the model wrote in\nand the prose under it.' },
]);

function bank(pages: { page: number; text: string; geometry?: boolean }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-blocks-test-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  const readings = VlmReadings.open(readingsPath);
  for (const page of pages) {
    readings.append({
      page: page.page,
      text: page.text,
      tokens: 100,
      finishReason: 'stop',
      seconds: 1,
      ...(page.geometry === false ? {} : { render: RENDER, maxPixels: MAX_PIXELS, model: 'dots-ocr' }),
    });
  }
  return readingsPath;
}

const silent = (): void => {};

test('the blocks are the parser\'s own, ids and boxes alike, with no PDF anywhere', async () => {
  const dump = await dumpBlocks({
    readingsPath: bank([{ page: 4, text: PAGE_ANSWER }]),
    modelId: 'dots-ocr',
    log: silent,
  });

  assert.equal(dump.version, 1);
  assert.equal(dump.kind, 'blocks');
  assert.equal(dump.pages.length, 1);
  const page = dump.pages[0];
  assert.equal(page.page, 4);
  assert.deepEqual(page.render, RENDER);
  assert.equal(page.maxPixels, MAX_PIXELS);
  // The whole point of banking the geometry: nothing was rasterised.
  assert.equal(page.geometry, 'bank');

  const parsed = parseDotsPage(PAGE_ANSWER, { page: 4, render: RENDER, maxPixels: MAX_PIXELS });
  const expected = [...parsed.blocks, ...parsed.furniture]
    .sort((a, b) => a.order - b.order || a.part - b.part)
    .map((b) => ({
      page: b.page, order: b.order, part: b.part, category: b.category, box: b.box, text: b.text,
    }));
  assert.deepEqual(page.blocks, expected);
});

test('the furniture is in the dump, in the model\'s own answer order', async () => {
  const dump = await dumpBlocks({
    readingsPath: bank([{ page: 1, text: PAGE_ANSWER }]),
    modelId: 'dots-ocr',
    log: silent,
  });
  const blocks = dump.pages[0].blocks;
  // A page drawn with a hole in it where the folio was is a page whose outlines
  // do not match the paper.
  assert.equal(blocks[0].category, 'Page-header');
  assert.deepEqual(blocks.map((b) => [b.order, b.part]), [[0, 0], [1, 0], [2, 0], [2, 1]]);
});

test('a split answer element gives its sub-blocks the parts an overlay names them by', async () => {
  const dump = await dumpBlocks({
    readingsPath: bank([{ page: 1, text: PAGE_ANSWER }]),
    modelId: 'dots-ocr',
    log: silent,
  });
  const split = dump.pages[0].blocks.filter((b) => b.order === 2);
  assert.deepEqual(split.map((b) => [b.part, b.category, b.text]), [
    [0, 'Title', 'A heading the model wrote in'],
    [1, 'Text', 'and the prose under it.'],
  ]);
});

test('a page whose answer will not parse is reported by number and costs the others nothing', async () => {
  const dump = await dumpBlocks({
    readingsPath: bank([
      { page: 1, text: PAGE_ANSWER },
      { page: 2, text: 'the model answered with a paragraph of prose' },
      { page: 3, text: PAGE_ANSWER },
    ]),
    modelId: 'dots-ocr',
    log: silent,
  });
  assert.deepEqual(dump.pages.map((p) => p.page), [1, 3]);
  assert.equal(dump.unreadable.length, 1);
  assert.equal(dump.unreadable[0].page, 2);
  assert.match(dump.unreadable[0].reason, /not JSON/);
});

test('a bank with no geometry and no --pdf is refused with the pages named', async () => {
  const readingsPath = bank([
    { page: 1, text: PAGE_ANSWER, geometry: false },
    { page: 2, text: PAGE_ANSWER, geometry: false },
  ]);
  await assert.rejects(
    () => dumpBlocks({ readingsPath, modelId: 'dots-ocr', log: silent }),
    (err: unknown) => err instanceof VlmBlocksError
      && /page\(s\) 1, 2/.test(err.message)
      && /--pdf/.test(err.message),
  );
});

test('an empty bank and a missing bank are refused by name, never dumped as nothing', async () => {
  const empty = bank([]);
  fs.writeFileSync(empty, '');
  await assert.rejects(
    () => dumpBlocks({ readingsPath: empty, modelId: 'dots-ocr', log: silent }),
    (err: unknown) => err instanceof VlmBlocksError && /banks no page answers/.test(err.message),
  );
  await assert.rejects(
    () => dumpBlocks({ readingsPath: path.join(path.dirname(empty), 'nope.jsonl'), modelId: 'dots-ocr', log: silent }),
    (err: unknown) => err instanceof VlmBlocksError && /no such readings file/.test(err.message),
  );
});

test('a dialect with no geometry has no blocks to draw and says so', async () => {
  await assert.rejects(
    () => dumpBlocks({
      readingsPath: bank([{ page: 1, text: PAGE_ANSWER }]),
      modelId: 'olmocr-7b',
      log: silent,
    }),
    (err: unknown) => err instanceof VlmBlocksError && /which is prose/.test(err.message),
  );
});

test('the bank is only ever READ: no marker is written and nothing is archived', async () => {
  const readingsPath = bank([{ page: 1, text: PAGE_ANSWER }]);
  const dir = path.dirname(readingsPath);
  const before = fs.readdirSync(dir).sort();
  await dumpBlocks({ readingsPath, modelId: 'dots-ocr', log: silent });
  // It must be safe to run over a bank in the middle of somebody's conversion.
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(VlmReadings.open(readingsPath).size, 1);
});

// ── the chapters the engine would find ──────────────────────────────────────

/** Three pages of a book with two chapter openers in it, as dots would answer. */
const CHAPTER_PAGES = [
  {
    page: 1,
    text: JSON.stringify([
      { bbox: [400, 200, 900, 300], category: 'Title', text: 'CHAPTER I' },
      { bbox: [200, 400, 1100, 900], category: 'Text', text: `The first chapter opens. ${'word '.repeat(30)}` },
    ]),
  },
  {
    page: 2,
    text: JSON.stringify([
      { bbox: [200, 400, 1100, 900], category: 'Text', text: `The middle of it. ${'word '.repeat(30)}` },
    ]),
  },
  {
    page: 3,
    text: JSON.stringify([
      { bbox: [400, 200, 900, 300], category: 'Title', text: 'CHAPTER II' },
      { bbox: [200, 400, 1100, 900], category: 'Text', text: `The second chapter opens. ${'word '.repeat(30)}` },
    ]),
  },
];

test('the dump reports the spine this engine would build, location and name', async () => {
  const dump = await dumpBlocks({
    readingsPath: bank(CHAPTER_PAGES),
    modelId: 'dots-ocr',
    log: silent,
  });
  assert.deepEqual(dump.chapters, [
    { page: 1, order: 0, part: 0, title: 'CHAPTER I' },
    { page: 3, order: 0, part: 0, title: 'CHAPTER II' },
  ]);
});

test('the seed and the render agree: the dump\'s chapters are the book\'s chapters', async () => {
  /*
   * THE CLAIM THAT MATTERS. An app opens its editor with this list in front of
   * somebody; if saving it back unchanged produced a different book, the first
   * thing anybody did after opening the editor would silently change their
   * book. So the same answers are dumped AND built, and the two spines are
   * compared: the labels the nav will carry, and the pages they start on.
   */
  const readingsPath = bank(CHAPTER_PAGES);
  const dump = await dumpBlocks({ readingsPath, modelId: 'dots-ocr', log: silent });

  const built = await buildDotsBook({
    metadata: { title: 'A Book', language: 'en', identifier: 'urn:x:1' },
    pages: CHAPTER_PAGES.map((p) => parseDotsPage(p.text, {
      page: p.page, render: RENDER, maxPixels: MAX_PIXELS,
    })),
    images: { inkExtent: () => null, crop: async () => [] },
    stripNoteMarkers: false,
  });
  assert.deepEqual(
    built.chapters.map((c) => [c.label, c.firstPage]),
    dump.chapters.map((c) => [c.title, c.page]),
  );

  // And handing that same list straight back as a spine renders the same book,
  // which is what "saving it unchanged" has to mean.
  const relisted = await buildDotsBook({
    metadata: { title: 'A Book', language: 'en', identifier: 'urn:x:1' },
    pages: CHAPTER_PAGES.map((p) => parseDotsPage(p.text, {
      page: p.page, render: RENDER, maxPixels: MAX_PIXELS,
    })),
    images: { inkExtent: () => null, crop: async () => [] },
    stripNoteMarkers: false,
    overlay: parseOverlay(JSON.stringify({
      overlay: 1,
      amendments: [],
      chapters: dump.chapters.map((c) => ({
        at: { page: c.page, order: c.order, part: c.part },
        title: c.title,
      })),
    }), 'overlay.json'),
  });
  assert.deepEqual(
    relisted.chapters.map((c) => [c.label, c.firstPage, c.lastPage]),
    built.chapters.map((c) => [c.label, c.firstPage, c.lastPage]),
  );
});
