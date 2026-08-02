/**
 * The exporter, over the three synthetic books in `fixtures/export/`.
 *
 * The three carry the SAME content laid out under three different paragraph
 * conventions, so the tests can assert the property that matters most: the book
 * that comes out does not depend on how the source happened to mark its
 * paragraphs — and the third book, which marks them not at all, still exports.
 *
 * Structure is checked by unzipping the writer's own output with an independent
 * reader and parsing the XHTML for well-formedness. A substring assertion would
 * pass on a file no reader can open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage } from '../../src/pipeline/export-stage.js';
import type { ExportStageResult } from '../../src/pipeline/export-stage.js';
import { readBlocks, readExclusions, readScanLines } from '../../src/pipeline/artifacts.js';
import { EpubError } from '../../src/export/epub.js';
import { CONVENTIONS, runDirFor, buildRun, type Convention } from '../../fixtures/export/generate.js';
import { unzipMap } from './unzip.js';
import { checkXml } from './xmlcheck.js';

const METADATA = {
  title: 'A Synthetic Book',
  language: 'en',
  identifier: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  author: 'A. Fixture',
};

/**
 * Export into a COPY of the fixture, so the committed run directories are never
 * mutated by a test run and the drift guard stays meaningful.
 */
function exportBook(
  convention: Convention,
  exclude?: { categories?: string[]; blockIds?: string[] },
): { result: ExportStageResult; runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `foundry-export-${convention}-`));
  const runDir = join(root, `${convention}-book`);
  buildRun(convention, runDir);
  const result = runExportStage({ runDir, metadata: METADATA, exclude, log: () => {} });
  return { result, runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withBook(
  convention: Convention,
  fn: (r: ExportStageResult, runDir: string) => void,
  exclude?: { categories?: string[]; blockIds?: string[] },
): void {
  const { result, runDir, cleanup } = exportBook(convention, exclude);
  try { fn(result, runDir); } finally { cleanup(); }
}

// ── the fixtures themselves ─────────────────────────────────────────────────

test('the committed fixtures have not drifted from the generator', () => {
  // The fixtures are committed so an integration consumer can read them, and
  // regenerated here so they cannot quietly stop being what the generator makes.
  for (const convention of CONVENTIONS) {
    const root = mkdtempSync(join(tmpdir(), 'foundry-drift-'));
    try {
      const fresh = join(root, `${convention}-book`);
      buildRun(convention, fresh);
      const committed = runDirFor(convention);
      assert.deepEqual(readBlocks(fresh), readBlocks(committed), `${convention}: boxes/blocks.json drifted`);
      assert.deepEqual(readScanLines(fresh), readScanLines(committed), `${convention}: scan/lines.json drifted`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('each fixture calibrates to the convention it was laid out in', () => {
  for (const convention of CONVENTIONS) {
    const { calibration } = readBlocks(runDirFor(convention));
    assert.equal(calibration.convention, convention, `${convention}-book calibrated as ${calibration.convention}`);
    assert.equal(calibration.degraded, convention === 'none');
  }
});

// ── container structure ─────────────────────────────────────────────────────

test('the container has the EPUB layout, mimetype first', () => {
  withBook('indent', r => {
    assert.equal(r.entryPaths[0], 'mimetype');
    for (const required of ['mimetype', 'META-INF/container.xml', 'EPUB/package.opf', 'EPUB/nav.xhtml', 'EPUB/style.css']) {
      assert.ok(r.entryPaths.includes(required), `missing ${required}`);
    }
    const files = unzipMap(r.zip);
    assert.equal(files.get('mimetype')!.text(), 'application/epub+zip');
    assert.equal(files.get('mimetype')!.method, 0);
    assert.equal(files.get('mimetype')!.localOffset, 0);
  });
});

test('every XML file in the container is well-formed', () => {
  for (const convention of CONVENTIONS) {
    withBook(convention, r => {
      for (const [path, entry] of unzipMap(r.zip)) {
        if (!path.endsWith('.xml') && !path.endsWith('.xhtml') && !path.endsWith('.opf')) continue;
        checkXml(entry.text(), `${convention}:${path}`, { xhtml: path.endsWith('.xhtml') });
      }
    });
  }
});

test('container.xml points at the package document, which exists', () => {
  withBook('indent', r => {
    const files = unzipMap(r.zip);
    const container = files.get('META-INF/container.xml')!.text();
    const m = /full-path="([^"]+)"/.exec(container);
    assert.ok(m, 'container.xml carries no rootfile path');
    assert.ok(files.has(m[1]), `container.xml points at ${m[1]}, which is not in the archive`);
    assert.match(container, /media-type="application\/oebps-package\+xml"/);
  });
});

test('the package document declares EPUB 3, its metadata, and a nav item', () => {
  withBook('indent', r => {
    const opf = unzipMap(r.zip).get('EPUB/package.opf')!.text();
    assert.match(opf, /<package [^>]*version="3\.0"/);
    assert.match(opf, /unique-identifier="pub-id"/);
    assert.match(opf, /<dc:identifier id="pub-id">urn:uuid:00000000-0000-4000-8000-000000000000<\/dc:identifier>/);
    assert.match(opf, /<dc:title>A Synthetic Book<\/dc:title>/);
    assert.match(opf, /<dc:language>en<\/dc:language>/);
    assert.match(opf, /<dc:creator>A\. Fixture<\/dc:creator>/);
    assert.match(opf, /<meta property="dcterms:modified">/);
    assert.match(opf, /properties="nav"/);
  });
});

test('every manifest item exists in the archive, and every spine idref is manifested', () => {
  withBook('indent', r => {
    const files = unzipMap(r.zip);
    const opf = files.get('EPUB/package.opf')!.text();
    const items = new Map<string, string>();
    for (const m of opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)) items.set(m[1], m[2]);
    assert.ok(items.size >= 3);
    for (const [id, href] of items) {
      assert.ok(files.has(`EPUB/${href}`), `manifest item ${id} points at missing EPUB/${href}`);
    }
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map(m => m[1]);
    assert.ok(spine.length > 0);
    for (const idref of spine) assert.ok(items.has(idref), `spine references unmanifested ${idref}`);
  });
});

// ── chapters and the TOC ────────────────────────────────────────────────────

test('a chapter block starts a spine item and a TOC entry labelled with its text', () => {
  withBook('indent', r => {
    assert.deepEqual(r.sections.map(s => s.label), ['A Synthetic Book', 'Chapter One', 'Chapter Two']);
    const files = unzipMap(r.zip);
    const nav = files.get('EPUB/nav.xhtml')!.text();
    const entries = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => ({ href: m[1], label: m[2] }));
    assert.deepEqual(entries.map(e => e.label), ['A Synthetic Book', 'Chapter One', 'Chapter Two']);
    for (const e of entries) assert.ok(files.has(`EPUB/${e.href}`), `TOC points at missing ${e.href}`);
    assert.match(nav, /<nav epub:type="toc"/);
    // One spine item per section.
    const opf = files.get('EPUB/package.opf')!.text();
    assert.equal([...opf.matchAll(/<itemref /g)].length, r.sections.length);
  });
});

test('a title block opens the title section', () => {
  withBook('indent', r => {
    const first = unzipMap(r.zip).get(`EPUB/${r.sections[0].href}`)!.text();
    assert.match(first, /<h1 class="title">A Synthetic Book<\/h1>/);
    // And a chapter gets a plain h1, not the title class.
    const second = unzipMap(r.zip).get(`EPUB/${r.sections[1].href}`)!.text();
    assert.match(second, /<h1>Chapter One<\/h1>/);
  });
});

test('the three conventions produce the same sections and the same chapter split', () => {
  const labels = CONVENTIONS.map(c => {
    let out: string[] = [];
    withBook(c, r => { out = r.sections.map(s => s.label); });
    return out;
  });
  assert.deepEqual(labels[0], labels[1]);
  assert.deepEqual(labels[1], labels[2]);
});

// ── category rendering ──────────────────────────────────────────────────────

test('headings, quotes, captions and lists get their own elements', () => {
  withBook('indent', r => {
    const chapter = unzipMap(r.zip).get(`EPUB/${r.sections[1].href}`)!.text();
    assert.match(chapter, /<h2>A Heading That Sits In Place<\/h2>/);
    assert.match(chapter, /<h3>A Subheading Beneath It<\/h3>/);
    assert.match(chapter, /<blockquote><p>A quoted passage sits here/);
    assert.match(chapter, /<p class="caption">Figure 1\./);
    // A list keeps the author's line breaks: one item per line, not one
    // run-on sentence.
    assert.match(chapter, /<ul>\n {2}<li>The first item<\/li>\n {2}<li>The second item<\/li>\n {2}<li>The third item<\/li>\n<\/ul>/);
  });
});

test('footnotes are collected at the end of their section and are NOT linked', () => {
  withBook('indent', r => {
    const chapter = unzipMap(r.zip).get(`EPUB/${r.sections[1].href}`)!.text();
    assert.match(chapter, /<section epub:type="footnotes"/);
    assert.match(chapter, /<p class="footnote">1\. A footnote at the foot of its own page\.<\/p>/);
    // No body linking, in either direction: the markers are removed upstream,
    // so there is nothing to point at and no anchor to point back to.
    assert.equal(/<a /.test(chapter), false, 'a section document contains a link');
    // The note follows the body text, not precedes it.
    assert.ok(chapter.indexOf('A quoted passage') < chapter.indexOf('epub:type="footnotes"'));
  });
});

test('running heads, folios and discard never appear in any section', () => {
  for (const convention of CONVENTIONS) {
    withBook(convention, r => {
      const all = [...unzipMap(r.zip)]
        .filter(([p]) => p.startsWith('EPUB/text/'))
        .map(([, e]) => e.text())
        .join('\n');
      assert.equal(all.includes('A SYNTHETIC BOOK'), false, `${convention}: a running head was emitted`);
      assert.equal(all.includes('a leak from the facing page'), false, `${convention}: a discard block was emitted`);
      assert.equal(/>\s*1[2-9]\s*</.test(all), false, `${convention}: a folio was emitted`);
    });
  }
});

// ── paragraphs ──────────────────────────────────────────────────────────────

test('a paragraph that crosses a page break comes out as ONE paragraph', () => {
  for (const convention of CONVENTIONS) {
    withBook(convention, r => {
      const first = unzipMap(r.zip).get(`EPUB/${r.sections[0].href}`)!.text();
      const joined = 'Sometimes the turn falls inside a word, like question, which the book itself';
      assert.ok(first.includes(joined), `${convention}: the page-spanning paragraph was split`);
    });
  }
});

test('the wrap-hyphen verdicts are decided by the book, not by the convention', () => {
  for (const convention of CONVENTIONS) {
    withBook(convention, r => {
      const all = [...unzipMap(r.zip)]
        .filter(([p]) => p.startsWith('EPUB/text/'))
        .map(([, e]) => e.text()).join('\n');
      // Attested as a word ⇒ healed.
      assert.ok(all.includes('like question, which'), `${convention}: ques-tion was not healed`);
      assert.equal(all.includes('ques-tion'), false, `${convention}: ques-tion kept a hyphen`);
      // Attested as a compound ⇒ hyphen kept.
      assert.ok(all.includes('split as far-right, which'), `${convention}: far-right was welded`);
      assert.equal(all.includes('farright'), false, `${convention}: far-right was welded`);
      // Unproven ⇒ hyphen kept.
      assert.ok(all.includes('a zeb-ruck, which'), `${convention}: zeb-ruck changed`);
      assert.equal(all.includes('zebruck'), false, `${convention}: an unproven pair was welded`);
      assert.equal(r.healedHyphens, 1);
      assert.equal(r.keptHyphens, 2);
    });
  }
});

test('the indent and block books produce identical prose', () => {
  const prose = (c: Convention): string => {
    let text = '';
    withBook(c, r => {
      text = [...unzipMap(r.zip)]
        .filter(([p]) => p.startsWith('EPUB/text/'))
        .map(([, e]) => e.text()).join('\n');
    });
    return text;
  };
  assert.equal(prose('indent'), prose('block'));
});

test('the stylesheet follows the calibrated convention', () => {
  withBook('indent', r => {
    assert.match(unzipMap(r.zip).get('EPUB/style.css')!.text(), /p \{ margin: 0; text-indent: 1\.5em; \}/);
  });
  withBook('block', r => {
    assert.match(unzipMap(r.zip).get('EPUB/style.css')!.text(), /p \{ margin: 0 0 0\.8em; text-indent: 0; \}/);
  });
});

// ── THE DEGRADATION ─────────────────────────────────────────────────────────

test('the no-convention book exports successfully, degraded and loud', () => {
  const messages: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'foundry-degrade-'));
  try {
    const runDir = join(root, 'none-book');
    buildRun('none', runDir);
    const r = runExportStage({ runDir, metadata: METADATA, log: m => messages.push(m) });

    // It exported.
    assert.ok(r.zip.length > 0);
    assert.equal(r.sections.length, 3);
    assert.ok(unzipMap(r.zip).has('EPUB/package.opf'));

    // It is flagged, in the returned result and in the artifact's own verdict.
    assert.equal(r.degraded, true);
    assert.equal(r.grouping.degraded, true);
    assert.equal(r.grouping.convention, 'none');
    assert.equal(readBlocks(runDir).calibration.convention, 'none');
    assert.equal(readBlocks(runDir).calibration.degraded, true);

    // It is LOUD: the banner names the condition, the counts, and that the run
    // did not fail.
    const said = messages.join('\n');
    assert.match(said, /DEGRADED PARAGRAPH ASSEMBLY/);
    assert.match(said, /NO DETECTABLE PARAGRAPH CONVENTION/);
    assert.match(said, /THE RUN DID NOT FAIL/);
    assert.match(said, /merged rather than guessed/);
    assert.match(said, /Calibration measured: indent — .*; gap — .*\./);

    // And the observable behaviour is FEWER breaks, never more.
    assert.equal(r.grouping.byLevel.geometry, 0, 'no geometric decision is available');
    assert.ok(r.grouping.byLevel.merge > 0, 'flowing junctions merged');
    assert.equal(r.grouping.byReason['merge:unsure'], r.grouping.byLevel.merge);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the degraded book has strictly fewer paragraphs than the calibrated ones', () => {
  const groups = (c: Convention): number => {
    let n = 0;
    withBook(c, r => { n = r.grouping.groups; });
    return n;
  };
  const none = groups('none');
  assert.ok(none < groups('indent'), `none ${none} vs indent ${groups('indent')}`);
  assert.ok(none < groups('block'));
});

test('a degraded book still breaks on the hard rules, so its structure survives', () => {
  withBook('none', r => {
    // Chapters, headings, quotes and captions are all category transitions, so
    // they are still separate elements even with no paragraph signal at all.
    const chapter = unzipMap(r.zip).get(`EPUB/${r.sections[1].href}`)!.text();
    assert.match(chapter, /<h1>Chapter One<\/h1>/);
    assert.match(chapter, /<h2>A Heading That Sits In Place<\/h2>/);
    assert.match(chapter, /<blockquote>/);
    assert.match(chapter, /<p class="caption">/);
    assert.ok(r.grouping.byLevel.hard > 0);
  });
});

// ── exclusions, end to end ──────────────────────────────────────────────────

test('--exclude by category removes it from the book and records it', () => {
  withBook('indent', (r, runDir) => {
    const all = [...unzipMap(r.zip)].filter(([p]) => p.startsWith('EPUB/text/'))
      .map(([, e]) => e.text()).join('\n');
    assert.equal(all.includes('A footnote at the foot'), false);
    assert.equal(/epub:type="footnotes"/.test(all), false, 'an empty notes section was emitted');
    assert.equal(all.includes('Figure 1.'), false);

    const record = readExclusions(runDir);
    assert.deepEqual(record.excludedCategories, ['footnote', 'caption']);
    assert.deepEqual(record.droppedByCategory, { footnote: 2, caption: 1 });
    assert.equal(record.droppedById, 0);
    assert.equal(record.keptBlocks + 3 + 9, record.totalBlocks);
  }, { categories: ['footnotes', 'captions'] });
});

test('--exclude by block id removes exactly that box', () => {
  const runDir = runDirFor('indent');
  const blocks = readBlocks(runDir).blocks;
  const target = blocks.find(b => b.category === 'image')!;
  withBook('indent', (r, dir) => {
    const all = [...unzipMap(r.zip)].filter(([p]) => p.startsWith('EPUB/text/'))
      .map(([, e]) => e.text()).join('\n');
    assert.equal(all.includes('TEXT READ OFF A PHOTOGRAPH'), false);
    const record = readExclusions(dir);
    assert.deepEqual(record.excludedBlockIds, [target.id]);
    assert.equal(record.droppedById, 1);
    assert.deepEqual(record.droppedByCategory, {});
  }, { blockIds: [target.id] });
});

test('the two granularities compose in a real export', () => {
  const target = readBlocks(runDirFor('indent')).blocks.find(b => b.category === 'image')!;
  withBook('indent', (r, dir) => {
    const all = [...unzipMap(r.zip)].filter(([p]) => p.startsWith('EPUB/text/'))
      .map(([, e]) => e.text()).join('\n');
    assert.equal(all.includes('TEXT READ OFF A PHOTOGRAPH'), false);
    assert.equal(all.includes('A footnote at the foot'), false);
    const record = readExclusions(dir);
    assert.equal(record.droppedById, 1);
    assert.deepEqual(record.droppedByCategory, { footnote: 2 });
  }, { categories: ['footnote'], blockIds: [target.id] });
});

test('exclusions.json records the never-emitted set too', () => {
  withBook('indent', (_r, dir) => {
    const record = readExclusions(dir);
    assert.deepEqual(record.neverEmittedCategories.sort(), ['discard', 'footer', 'header']);
    assert.equal(record.droppedByNeverEmitted['header'], 4);
    assert.equal(record.droppedByNeverEmitted['footer'], 4);
    assert.equal(record.droppedByNeverEmitted['discard'], 1);
  });
});

test('excluding everything is an error naming the arithmetic, not an empty book', () => {
  const { runDir, cleanup } = (() => {
    const root = mkdtempSync(join(tmpdir(), 'foundry-empty-'));
    const dir = join(root, 'indent-book');
    buildRun('indent', dir);
    return { runDir: dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  })();
  try {
    assert.throws(
      () => runExportStage({
        runDir,
        metadata: METADATA,
        exclude: { categories: ['body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption', 'list', 'image', 'footnote'] },
        log: () => {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof EpubError);
        assert.match(e.message, /no blocks survived the exclusions/);
        assert.match(e.message, /There is no book to write/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// ── reproducibility ─────────────────────────────────────────────────────────

test('re-exporting the same run produces byte-identical output', () => {
  // PIPELINE.md's promise: re-export is cheap and touches no upstream stage.
  // Byte identity is what makes "did my exclusion change anything" answerable.
  const root = mkdtempSync(join(tmpdir(), 'foundry-repro-'));
  try {
    const runDir = join(root, 'indent-book');
    buildRun('indent', runDir);
    const a = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    const b = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.deepEqual([...a.zip], [...b.zip]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changing an exclusion changes the bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-repro2-'));
  try {
    const runDir = join(root, 'indent-book');
    buildRun('indent', runDir);
    const a = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    const b = runExportStage({ runDir, metadata: METADATA, exclude: { categories: ['footnote'] }, log: () => {} });
    assert.notDeepEqual([...a.zip], [...b.zip]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
