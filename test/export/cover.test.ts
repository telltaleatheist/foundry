/**
 * `--cover <image>`: the one input to the export that the pipeline did not
 * produce.
 *
 * Two things are worth pinning. The first is the CONTRACT with the reader — a
 * manifest item marked `cover-image`, a page of its own first in the spine
 * holding nothing but that image, and the EPUB2 `<meta name="cover">` beside
 * it — because a cover that is present but not declared is a cover no library
 * shows. The second is that the format is read from the file's BYTES: a `.jpg`
 * that is really a PNG must be declared `image/png`, and a file that is neither
 * must stop the export naming itself rather than ship an image nothing decodes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage, ExportStageError, type ExportStageResult } from '../../src/pipeline/export-stage.js';
import { CoverError, coverFormat } from '../../src/export/cover.js';
import { unzipMap } from './unzip.js';
import { checkXml } from './xmlcheck.js';
import { buildSyntheticRun, METADATA, MORE_PROSE, PROSE, type SyntheticBlock } from './synthetic.js';

/** A real 1x1 PNG. Small, and an actual image rather than eight magic bytes. */
const PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
), c => c.charCodeAt(0));

/** JFIF SOI + APP0, then EOI. Nothing in foundry decodes a cover. */
const JPEG = Uint8Array.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

const BOOK: SyntheticBlock[] = [
  { page: 0, category: 'title', texts: ['A Structured Book'] },
  { page: 1, category: 'chapter', texts: ['Chapter One'] },
  { page: 1, category: 'body', texts: PROSE },
  { page: 1, category: 'body', texts: MORE_PROSE },
  { page: 2, category: 'chapter', texts: ['Chapter Two'] },
  { page: 2, category: 'body', texts: PROSE },
];

function withCover(
  file: { name: string; bytes: Uint8Array } | null,
  fn: (r: ExportStageResult) => void,
  script: readonly SyntheticBlock[] = BOOK,
): void {
  const root = mkdtempSync(join(tmpdir(), 'foundry-cover-'));
  try {
    const runDir = join(root, 'book');
    buildSyntheticRun(runDir, script);
    let coverPath: string | undefined;
    if (file) {
      coverPath = join(root, file.name);
      writeFileSync(coverPath, file.bytes);
    }
    fn(runExportStage({
      runDir, metadata: METADATA, log: () => {}, ...(coverPath ? { coverPath } : {}),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── what lands in the container ─────────────────────────────────────────────

test('a PNG cover is embedded verbatim and declared as the cover image', () => {
  withCover({ name: 'cover.png', bytes: PNG }, r => {
    const files = unzipMap(r.zip);

    const image = files.get('EPUB/images/cover.png');
    assert.ok(image, `the cover image is not in the container: ${[...files.keys()].join(', ')}`);
    assert.deepEqual([...image.data], [...PNG], 'the cover bytes were altered');

    const opf = files.get('EPUB/package.opf')!.text();
    assert.match(opf, /<item id="cover-image" href="images\/cover\.png" media-type="image\/png" properties="cover-image"\/>/);
    // The EPUB2 spelling of the same fact, pointing at the same item.
    assert.match(opf, /<meta name="cover" content="cover-image"\/>/);
  });
});

test('the cover page is the first spine item and holds only the image', () => {
  withCover({ name: 'cover.png', bytes: PNG }, r => {
    assert.equal(r.sections[0].role, 'cover');
    assert.equal(r.sections[0].href, 'text/cover.xhtml');

    const files = unzipMap(r.zip);
    const opf = files.get('EPUB/package.opf')!.text();
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map(m => m[1]);
    assert.equal(spine[0], 'cover');
    assert.deepEqual(spine, r.sections.map(s => s.id));

    const page = files.get('EPUB/text/cover.xhtml')!.text();
    assert.match(page, /<section epub:type="cover" class="cover">/);
    assert.match(page, /<img src="\.\.\/images\/cover\.png" alt=""\/>/);
    // Only the image: no paragraph, no heading, no caption under it.
    assert.equal(/<(p|h1|h2|h3)[ >]/.test(page), false, 'the cover page carries text');
    checkXml(page, 'cover.xhtml', { xhtml: true });
  });
});

test('cover, then title page, then the chapters', () => {
  withCover({ name: 'cover.png', bytes: PNG }, r => {
    assert.deepEqual(r.sections.map(s => s.role), ['cover', 'titlepage', 'text', 'text']);

    const nav = unzipMap(r.zip).get('EPUB/nav.xhtml')!.text();
    const toc = /<nav epub:type="toc"[\s\S]*?<\/nav>/.exec(nav)![0];
    assert.equal(toc.includes('cover.xhtml'), false, 'the cover took a TOC entry');
    const marks = /<nav epub:type="landmarks"[\s\S]*?<\/nav>/.exec(nav)![0];
    assert.deepEqual(
      [...marks.matchAll(/<a epub:type="([^"]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]),
      [['cover', 'text/cover.xhtml'], ['titlepage', 'text/s0001.xhtml'], ['bodymatter', 'text/s0002.xhtml']],
    );
    checkXml(nav, 'nav.xhtml', { xhtml: true });
  });
});

test('adding a cover renumbers nothing else in the book', () => {
  let without: string[] = [];
  withCover(null, r => { without = r.sections.map(s => s.href); });
  withCover({ name: 'cover.png', bytes: PNG }, r => {
    assert.deepEqual(r.sections.slice(1).map(s => s.href), without);
  });
});

test('without --cover there is no cover page, no image and no cover metadata', () => {
  withCover(null, r => {
    const files = unzipMap(r.zip);
    assert.equal([...files.keys()].some(p => p.startsWith('EPUB/images/')), false);
    assert.equal(files.has('EPUB/text/cover.xhtml'), false);
    const opf = files.get('EPUB/package.opf')!.text();
    assert.equal(/cover/.test(opf), false, 'the package mentions a cover that was never given');
  });
});

// ── the format is what the file IS ──────────────────────────────────────────

test('the format comes from the magic bytes, not from the extension', () => {
  // A JPEG named .png: the entry gets .jpg and the media type image/jpeg,
  // because the media type has to describe the bytes a reader will decode.
  withCover({ name: 'cover.png', bytes: JPEG }, r => {
    const files = unzipMap(r.zip);
    assert.ok(files.has('EPUB/images/cover.jpg'));
    assert.equal(files.has('EPUB/images/cover.png'), false);
    assert.match(files.get('EPUB/package.opf')!.text(), /media-type="image\/jpeg" properties="cover-image"/);
  });
});

test('a file that is neither a JPEG nor a PNG stops the export and is named', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\nnot an image at all\n');
  assert.throws(
    () => withCover({ name: 'cover.jpg', bytes }, () => {
      assert.fail('the export accepted a PDF as a cover');
    }),
    (e: unknown) => {
      assert.ok(e instanceof CoverError, `expected a CoverError, got ${String(e)}`);
      assert.match(e.message, /cover\.jpg is not a JPEG or a PNG/);
      assert.match(e.message, /25 50 44 46/);
      assert.match(e.message, /foundry does not re-encode images/);
      return true;
    },
  );
});

test('an empty cover file is refused too', () => {
  assert.throws(
    () => withCover({ name: 'cover.png', bytes: new Uint8Array(0) }, () => {
      assert.fail('the export accepted an empty file as a cover');
    }),
    (e: unknown) => {
      assert.ok(e instanceof CoverError);
      assert.match(e.message, /cover\.png is empty/);
      return true;
    },
  );
});

test('a --cover that does not exist is a stop naming the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-cover-missing-'));
  try {
    const runDir = join(root, 'book');
    buildSyntheticRun(runDir, BOOK);
    assert.throws(
      () => runExportStage({
        runDir, metadata: METADATA, coverPath: join(root, 'nowhere.png'), log: () => {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ExportStageError);
        assert.match(e.message, /--cover: no such file:.*nowhere\.png/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the detector on its own ─────────────────────────────────────────────────

test('coverFormat maps each magic number to its media type and extension', () => {
  assert.deepEqual(coverFormat({ data: PNG, sourcePath: 'x' }), { mediaType: 'image/png', extension: 'png' });
  assert.deepEqual(coverFormat({ data: JPEG, sourcePath: 'x' }), { mediaType: 'image/jpeg', extension: 'jpg' });
  // Two bytes of a JPEG's three are not a JPEG: a truncated header is refused
  // rather than read as the format it was on its way to being.
  assert.throws(() => coverFormat({ data: JPEG.slice(0, 2), sourcePath: 'half.jpg' }), CoverError);
});
