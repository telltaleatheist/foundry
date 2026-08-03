/**
 * A title PAGE is a spine item of its own — and a title BLOCK is not.
 *
 * Nothing in the run directory says "this page is the title page": blocks carry
 * a category and a page number and that is all. So the exporter derives it, by
 * the same question the blocks stage's page gate asks — is there a page here
 * that is nothing but title? These tests pin both halves of that: the page that
 * qualifies becomes its own section ahead of the first chapter, listed in
 * landmarks and not in the contents, and the title that shares its page with
 * prose keeps the behaviour it always had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage, type ExportStageResult } from '../../src/pipeline/export-stage.js';
import { unzipMap } from './unzip.js';
import { checkXml } from './xmlcheck.js';
import { buildSyntheticRun, METADATA, MORE_PROSE, PROSE, type SyntheticBlock } from './synthetic.js';

function withRun(script: readonly SyntheticBlock[], fn: (r: ExportStageResult) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'foundry-titlepage-'));
  try {
    const runDir = join(root, 'book');
    buildSyntheticRun(runDir, script);
    fn(runExportStage({ runDir, metadata: METADATA, log: () => {} }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Page 0 carries nothing but the title, set over three blocks. */
const TITLE_PAGE: SyntheticBlock[] = [
  { page: 0, category: 'title', texts: ['A Structured Book'] },
  { page: 0, category: 'title', texts: ['Being an Account of Pages'] },
  { page: 0, category: 'title', texts: ['A. Fixture'] },
  { page: 1, category: 'chapter', texts: ['Chapter One'] },
  { page: 1, category: 'body', texts: PROSE },
  { page: 1, category: 'body', texts: MORE_PROSE },
  { page: 2, category: 'chapter', texts: ['Chapter Two'] },
  { page: 2, category: 'body', texts: PROSE },
];

/** The same title, sharing its page with the prose that follows it. */
const TITLE_BLOCK: SyntheticBlock[] = [
  { page: 0, category: 'title', texts: ['A Structured Book'] },
  { page: 0, category: 'body', texts: PROSE },
  { page: 1, category: 'chapter', texts: ['Chapter One'] },
  { page: 1, category: 'body', texts: MORE_PROSE },
  { page: 1, category: 'body', texts: PROSE },
];

const tocHrefs = (nav: string): string[] => {
  const toc = /<nav epub:type="toc"[\s\S]*?<\/nav>/.exec(nav);
  assert.ok(toc, 'nav.xhtml has no toc nav');
  return [...toc[0].matchAll(/<a href="([^"]+)">/g)].map(m => m[1]);
};

const landmarks = (nav: string): Array<{ type: string; href: string }> => {
  const block = /<nav epub:type="landmarks"[\s\S]*?<\/nav>/.exec(nav);
  assert.ok(block, 'nav.xhtml has no landmarks nav');
  return [...block[0].matchAll(/<a epub:type="([^"]+)" href="([^"]+)">/g)]
    .map(m => ({ type: m[1], href: m[2] }));
};

test('a page that is nothing but title becomes its own section, first in the spine', () => {
  withRun(TITLE_PAGE, r => {
    assert.equal(r.sections[0].role, 'titlepage');
    assert.deepEqual(r.sections.map(s => s.role), ['titlepage', 'text', 'text']);

    // All three title blocks are in that ONE section, in reading order.
    const files = unzipMap(r.zip);
    const page = files.get(`EPUB/${r.sections[0].href}`)!.text();
    assert.match(page, /<section epub:type="titlepage" class="titlepage">/);
    const order = ['A Structured Book', 'Being an Account of Pages', 'A. Fixture']
      .map(t => page.indexOf(t));
    assert.ok(order.every(i => i >= 0), `a title block is missing: ${JSON.stringify(order)}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the title blocks are out of order');

    // And nothing else joined it.
    assert.equal(page.includes('The body of the chapter'), false);
    assert.equal(page.includes('Chapter One'), false);

    // It is the first spine item, ahead of the first chapter.
    const opf = files.get('EPUB/package.opf')!.text();
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map(m => m[1]);
    assert.deepEqual(spine, r.sections.map(s => s.id));
    assert.equal(spine[0], r.sections[0].id);
  });
});

test('the title page is in landmarks, not in the reading contents', () => {
  withRun(TITLE_PAGE, r => {
    const nav = unzipMap(r.zip).get('EPUB/nav.xhtml')!.text();
    const hrefs = tocHrefs(nav);
    assert.equal(hrefs.includes(r.sections[0].href), false, 'the title page took a TOC entry');
    assert.deepEqual(hrefs, ['text/s0002.xhtml', 'text/s0003.xhtml']);

    assert.deepEqual(landmarks(nav), [
      { type: 'titlepage', href: 'text/s0001.xhtml' },
      { type: 'bodymatter', href: 'text/s0002.xhtml' },
    ]);
    checkXml(nav, 'nav.xhtml', { xhtml: true });
  });
});

test('the shipped stylesheet styles the title page', () => {
  withRun(TITLE_PAGE, r => {
    const css = unzipMap(r.zip).get('EPUB/style.css')!.text();
    assert.match(css, /section\.titlepage \{[^}]*text-align: center;/);
    assert.match(css, /section\.titlepage p[^{]*\{[^}]*text-indent: 0;/);
  });
});

test('front matter after the title page opens its own section rather than joining it', () => {
  withRun([
    { page: 0, category: 'title', texts: ['A Structured Book'] },
    { page: 1, category: 'body', texts: PROSE },
    { page: 1, category: 'body', texts: MORE_PROSE },
    { page: 2, category: 'chapter', texts: ['Chapter One'] },
    { page: 2, category: 'body', texts: PROSE },
  ], r => {
    assert.deepEqual(r.sections.map(s => s.role), ['titlepage', 'text', 'text']);
    assert.deepEqual(r.sections.map(s => s.label), ['A Structured Book', 'Front matter', 'Chapter One']);
    const first = unzipMap(r.zip).get(`EPUB/${r.sections[0].href}`)!.text();
    assert.equal(first.includes('The body of the chapter'), false);
  });
});

test('a title block that shares its page with prose is NOT a title page', () => {
  withRun(TITLE_BLOCK, r => {
    assert.deepEqual(r.sections.map(s => s.role), ['text', 'text']);
    const files = unzipMap(r.zip);
    const first = files.get(`EPUB/${r.sections[0].href}`)!.text();
    // The behaviour it always had: the title opens an ordinary section, with an
    // h1.title, and the prose beneath it belongs to that section.
    assert.match(first, /<h1 class="title">A Structured Book<\/h1>/);
    assert.ok(first.includes('The body of the chapter'));
    assert.equal(/epub:type="titlepage"/.test(first), false);

    const nav = files.get('EPUB/nav.xhtml')!.text();
    assert.deepEqual(tocHrefs(nav), ['text/s0001.xhtml', 'text/s0002.xhtml']);
    assert.deepEqual(landmarks(nav), [{ type: 'bodymatter', href: 'text/s0001.xhtml' }]);
  });
});

test('excluding the title takes the title page with it', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-titlepage-x-'));
  try {
    const runDir = join(root, 'book');
    buildSyntheticRun(runDir, TITLE_PAGE);
    const r = runExportStage({
      runDir, metadata: METADATA, exclude: { categories: ['title'] }, log: () => {},
    });
    assert.deepEqual(r.sections.map(s => s.role), ['text', 'text']);
    const nav = unzipMap(r.zip).get('EPUB/nav.xhtml')!.text();
    assert.deepEqual(landmarks(nav), [{ type: 'bodymatter', href: 'text/s0001.xhtml' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a book that is nothing but title blocks has no title page to carve out', () => {
  // There is no book for it to come before, and a reading TOC with nothing in
  // it is not a document any reader will accept. (The blocks run five lines
  // apiece because calibration refuses to measure a book with less geometry
  // than that — the shape of the test, not of the rule.)
  const titleLines = (n: number): string[] =>
    Array.from({ length: 5 }, (_, i) => `Title page ${n}, line ${i + 1}`);
  withRun([
    { page: 0, category: 'title', texts: titleLines(1) },
    { page: 1, category: 'title', texts: titleLines(2) },
    { page: 2, category: 'title', texts: titleLines(3) },
  ], r => {
    assert.ok(r.sections.every(s => s.role === 'text'), 'a title page was carved out of a book of titles');
    const nav = unzipMap(r.zip).get('EPUB/nav.xhtml')!.text();
    assert.deepEqual(tocHrefs(nav), r.sections.map(s => s.href));
  });
});

test('every XML file in a book with a title page is well-formed', () => {
  withRun(TITLE_PAGE, r => {
    for (const [path, entry] of unzipMap(r.zip)) {
      if (!path.endsWith('.xml') && !path.endsWith('.xhtml') && !path.endsWith('.opf')) continue;
      checkXml(entry.text(), path, { xhtml: path.endsWith('.xhtml') });
    }
  });
});
