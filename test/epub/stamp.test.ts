/**
 * Stamping a book that was never foundry's: what each layer decides, what it
 * refuses to decide, and what it must not touch.
 *
 * The assertions that matter most are the NEGATIVE ones, for the same reason
 * they are in `final.test.ts`: a pass that stamps something nobody asked it to
 * is indistinguishable from a working one until somebody opens select mode and
 * finds a box drawn around the whole page. So the `<section epub:type="chapter">`
 * wrapping a document, the `<div>` inside it, the `<table>` under its wrapper,
 * the `<img>` inside its figure, the noteref anchor and everything in the nav
 * are each asserted to come out with nothing on them.
 *
 * The other half is the promise that makes running this on every import safe:
 * a second run writes nothing at all, and a book that already carries categories
 * keeps every one of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UsageError } from '../../src/args.js';
import { findCommand, runCommand } from '../../src/commands.js';
import { epubFinal } from '../../src/epub/final.js';
import { documentTokens, epubStamp, StampError, type StampReport } from '../../src/epub/stamp.js';
import { writeZip, zipText } from '../../src/export/zip.js';
import { SKIPPED_CATEGORIES, TRANSLATED_CATEGORIES } from '../../src/translate/blocks.js';
import { BookError, readFoundryBook } from '../../src/translate/book.js';
import { unzip, unzipMap, type UnzippedEntry } from '../export/unzip.js';
import {
  CHAPTER_PATH, NAV_PATH, OPF_PATH,
  PUBLISHER_ONE, PUBLISHER_ONE_PATH, PUBLISHER_TITLE_PAGE, PUBLISHER_TWO, PUBLISHER_TWO_PATH,
  foundryEpub, plainEpub, publisherEpub, withoutPagebreaks,
} from '../translate/fixture.js';

const quiet = (): void => {};

interface Run {
  report: StampReport;
  written: Map<string, UnzippedEntry>;
  one: string;
  two: string;
  nav: string;
  clean: () => void;
}

/** Write the book to a scratch file, stamp it, and read the result back. */
async function stamp(book: Uint8Array): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  const epub = path.join(dir, 'Buch.epub');
  const out = path.join(dir, 'Buch.stamped.epub');
  fs.writeFileSync(epub, book);
  const report = await epubStamp({ epubPath: epub, outPath: out, log: quiet });
  const written = unzipMap(new Uint8Array(fs.readFileSync(out)));
  return {
    report,
    written,
    one: written.get(PUBLISHER_ONE_PATH)?.text() ?? '',
    two: written.get(PUBLISHER_TWO_PATH)?.text() ?? '',
    nav: written.get(NAV_PATH)!.text(),
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The book unpacked into a directory — the app's working tree, which is stamped in place. */
function unpackTo(root: string, book: Uint8Array): void {
  for (const entry of unzip(book)) {
    const file = path.join(root, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
}

/** Every `data-bf-id` in a document, in order. */
function idsOf(markup: string): string[] {
  return [...markup.matchAll(/data-bf-id="([^"]*)"/g)].map((m) => m[1]!);
}

/**
 * The start tag of the element whose content begins with these words.
 *
 * Searched from `<body>` onwards, because a chapter's heading is also its
 * `<title>` in the head and nothing in the head is ever stamped.
 */
function tagBefore(markup: string, words: string): string {
  const body = markup.indexOf('<body');
  assert.ok(body >= 0, 'the document has no body');
  const at = markup.indexOf(words, body);
  assert.ok(at >= 0, `"${words}" is not in the body of the document at all`);
  const open = markup.lastIndexOf('<', at);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

// ── layer 1: the publisher's own semantics ───────────────────────────────────

test('epub:type and role are read as declarations, and they beat the shape', async () => {
  const run = await stamp(publisherEpub());
  try {
    // A `<div>` is a container by shape and prose by default. `epub:type` says
    // it is an epigraph, and the declaration wins.
    assert.match(
      tagBefore(run.one, 'Ein Sinnspruch'),
      /<div class="epi" epub:type="epigraph" data-bf-page="12" data-bf-cat="quote" data-bf-id="p12-3">/,
    );
    // An `<li>` is a list item by shape. `epub:type="endnote"` says it is a
    // note, and the declaration wins there too.
    assert.match(tagBefore(run.one, 'Die erste Note'), /data-bf-cat="footnote"/);
    assert.equal(run.report.byLayer.declaration, 2);
  } finally { run.clean(); }
});

test('a token that names apparatus is not a block, and its children still are', async () => {
  const run = await stamp(publisherEpub());
  try {
    // The two wrappers of the note apparatus. The `<ol>` is the case that
    // matters: the shape layer would have called it a list of list-items.
    assert.match(run.one, /<section epub:type="footnotes">/);
    assert.match(run.one, /<ol epub:type="endnotes">/);
    // …and the note inside it is stamped, which is the whole point of
    // suppression stopping at the element.
    assert.match(run.one, /<li epub:type="endnote" id="fn1" [^>]*data-bf-cat="footnote"/);
    // The reference number in the prose is apparatus too, and inline besides.
    assert.match(run.one, /<a epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1<\/sup><\/a>/);
  } finally { run.clean(); }
});

test('a declaration beats position: a fulltitle heading is not a chapter opener', async () => {
  const chapter = PUBLISHER_TWO.replace('<h1>', '<h1 epub:type="fulltitle">');
  const run = await stamp(publisherEpub(PUBLISHER_ONE, chapter));
  try {
    assert.match(tagBefore(run.two, 'Der zweite Teil'), /data-bf-cat="title"/);
    // And the document's prose is untouched by that decision.
    assert.match(tagBefore(run.two, 'Ein Absatz ohne'), /data-bf-cat="text"/);
  } finally { run.clean(); }
});

// ── layer 2: shape ───────────────────────────────────────────────────────────

test('the shapes are read as the emitter writes them, container and child both', async () => {
  const run = await stamp(publisherEpub());
  try {
    // A quotation: the `<blockquote>` and each `<p>` inside it, exactly as
    // `dots-book.ts` stamps both halves.
    assert.match(run.one, /<blockquote data-bf-page="12" data-bf-cat="quote" data-bf-id="p12-4">/);
    assert.match(tagBefore(run.one, 'Ein langes Zitat'), /data-bf-cat="quote" data-bf-id="p12-5"/);
    assert.match(tagBefore(run.one, 'Und noch ein Satz'), /data-bf-cat="quote" data-bf-id="p12-6"/);
    // A list: the `<ul>` and each `<li>`, which is why ids count elements.
    assert.match(run.one, /<ul data-bf-page="12" data-bf-cat="list-item" data-bf-id="p12-7">/);
    assert.match(tagBefore(run.one, 'Erstens die Ordnung'), /data-bf-cat="list-item" data-bf-id="p12-8"/);
    assert.match(tagBefore(run.one, 'Zweitens die Ruhe'), /data-bf-cat="list-item" data-bf-id="p12-9"/);
    // A picture, and the caption that belongs to it.
    assert.match(run.one, /<figure data-bf-page="12" data-bf-cat="picture" data-bf-id="p12-10">/);
    assert.match(tagBefore(run.one, 'Die Tafel von gestern'), /data-bf-cat="caption" data-bf-id="p12-11"/);
    // A table, stamped on the WRAPPER, which is where the emitter puts it.
    assert.match(run.one, /<div class="tablewrap" data-bf-page="12" data-bf-cat="table" data-bf-id="p12-12">/);
  } finally { run.clean(); }
});

test('a container is not a block, and neither is anything inside a stamped one', async () => {
  const run = await stamp(publisherEpub());
  try {
    // The two containers, which would each put a box round the whole page.
    assert.match(run.one, /<section epub:type="chapter">/);
    assert.match(run.one, /<div class="body">/);
    // The table's own element and its cells: the wrapper is the block.
    assert.match(run.one, /<table><tr><td>Jahr<\/td><td>Zahl<\/td><\/tr><\/table>/);
    // The image inside its figure — the figure is the block.
    assert.match(run.one, /<img src="\.\.\/images\/plate\.png" alt="Tafel"\/>/);
    // Nothing whatever in the nav document, which is in this book's SPINE.
    assert.doesNotMatch(run.nav, /data-bf-/);
  } finally { run.clean(); }
});

// ── layer 3: position ────────────────────────────────────────────────────────

test('the first heading in a document opens a chapter and the rest are sections', async () => {
  const run = await stamp(publisherEpub());
  try {
    assert.match(tagBefore(run.one, 'Der erste Teil'), /data-bf-cat="chapter"/);
    assert.match(tagBefore(run.one, 'Ein Abschnitt'), /data-bf-cat="section-header"/);
    // Per DOCUMENT, not per book: the second chapter opens too.
    assert.match(tagBefore(run.two, 'Der zweite Teil'), /data-bf-cat="chapter"/);
    assert.equal(run.report.chapterOpeners, 2);
  } finally { run.clean(); }
});

test('a document with no prose on it carries titles, not a chapter opening', async () => {
  const run = await stamp(publisherEpub(PUBLISHER_ONE, PUBLISHER_TITLE_PAGE));
  try {
    assert.match(tagBefore(run.two, 'Der Staat'), /data-bf-cat="title"/);
    assert.match(tagBefore(run.two, 'Eine Untersuchung'), /data-bf-cat="title"/);
    assert.doesNotMatch(run.two, /data-bf-cat="chapter"/);
    // Named in the report, because it is the one positional decision a reader
    // of the file cannot see for themselves.
    assert.deepEqual(run.report.titleOnlyDocuments, [PUBLISHER_TWO_PATH]);
    assert.equal(run.report.chapterOpeners, 1);
  } finally { run.clean(); }
});

// ── layer 4: the default ─────────────────────────────────────────────────────

test('a paragraph carrying words is text, and one carrying none is nothing', async () => {
  const chapter = PUBLISHER_TWO.replace(
    '<p>Ein Absatz ohne jede Seitenangabe.</p>',
    '<p>Ein Absatz ohne jede Seitenangabe.</p>\n<p>  </p>\n<p><span>&#160;</span></p>',
  );
  const run = await stamp(publisherEpub(PUBLISHER_ONE, chapter));
  try {
    assert.match(tagBefore(run.two, 'Ein Absatz ohne'), /data-bf-cat="text"/);
    // Two spacer paragraphs: a box on the page with nothing in it to select.
    assert.match(run.two, /<p>\s*<\/p>/);
    assert.match(run.two, /<p><span>&#160;<\/span><\/p>/);
  } finally { run.clean(); }
});

// ── the pages, kept and never invented ───────────────────────────────────────

test("the book's own pagebreak markers become data-bf-page, from wherever the number is", async () => {
  const run = await stamp(publisherEpub());
  try {
    // `title="12"` on the first marker, `aria-label="13"` on the second: both
    // spellings are in the wild and both are read.
    assert.match(tagBefore(run.one, 'Der erste Teil'), /data-bf-page="12"/);
    assert.match(tagBefore(run.one, 'Ein Absatz auf Seite zwoelf'), /data-bf-page="12"/);
    assert.match(tagBefore(run.one, 'Ein Abschnitt'), /data-bf-page="13"/);
    assert.match(tagBefore(run.one, 'Ein Absatz auf Seite dreizehn'), /data-bf-page="13"/);
    assert.equal(run.report.pages, 2);

    // The markers themselves are not blocks and gain nothing.
    assert.match(run.one, /<span epub:type="pagebreak" role="doc-pagebreak" id="pb-12" title="12"><\/span>/);

    // AND THE SECOND DOCUMENT HAS NO PAGE AT ALL. It declares no marker, and the
    // last page the first document mentioned is a number nobody printed there.
    assert.doesNotMatch(run.two, /data-bf-page/);
  } finally { run.clean(); }
});

test('a marker whose label reads "Page 12" states page 12, and an odd one is kept verbatim', async () => {
  const chapter = PUBLISHER_ONE
    .replace('title="12"', 'aria-label="Page 12"')
    .replace('aria-label="13"', 'aria-label="Tafel II"');
  const run = await stamp(publisherEpub(chapter));
  try {
    // The word in front is the reading system's; the number is the book's.
    assert.match(tagBefore(run.one, 'Ein Absatz auf Seite zwoelf'), /data-bf-page="12"/);
    assert.match(tagBefore(run.one, 'Ein Absatz auf Seite zwoelf'), /data-bf-id="p12-2"/);

    // A label this does not recognise is still the page the book named, so it
    // is kept exactly — and the id falls back to the document, because an id
    // with a space in it is one the app refuses to address.
    const odd = tagBefore(run.one, 'Ein Absatz auf Seite dreizehn');
    assert.match(odd, /data-bf-page="Tafel II"/);
    assert.match(odd, /data-bf-id="cch01-\d+"/);
    assert.equal(run.report.pages, 2);
  } finally { run.clean(); }
});

test('a book with no pagination gets no page attribute and document-scoped ids', async () => {
  const run = await stamp(publisherEpub(withoutPagebreaks(PUBLISHER_ONE)));
  try {
    assert.equal(run.report.pages, 0);
    assert.equal(run.report.pagesStamped, 0);
    assert.doesNotMatch(run.one, /data-bf-page/);
    assert.doesNotMatch(run.two, /data-bf-page/);
    // `c<document>-<n>`, the token taken from the member's own name so that
    // moving a chapter renames nothing.
    assert.equal(idsOf(run.one)[0], 'cch01-1');
    assert.equal(idsOf(run.two)[0], 'cch02-1');
    // Still every block, still addressable — which is the point of the fallback.
    assert.match(tagBefore(run.one, 'Der erste Teil'), /data-bf-cat="chapter" data-bf-id="cch01-1"/);
  } finally { run.clean(); }
});

// ── the ids ──────────────────────────────────────────────────────────────────

test('ids are unique across the whole book, and a list and its items differ', async () => {
  for (const book of [publisherEpub(), publisherEpub(withoutPagebreaks(PUBLISHER_ONE))]) {
    const run = await stamp(book);
    try {
      const all = [...idsOf(run.one), ...idsOf(run.two)];
      assert.equal(all.length, 20, 'the fixture stamps twenty elements across its two documents');
      assert.equal(new Set(all).size, all.length, `two elements share a name: ${all.join(', ')}`);
      assert.equal(all.length, run.report.idsWritten);

      // The `<ul>` and both `<li>`s are three elements and three names — one id
      // on two elements is invalid XHTML and unaddressable besides.
      const list = /<ul [^>]*data-bf-id="([^"]*)"[^>]*>\s*<li [^>]*data-bf-id="([^"]*)"/.exec(run.one);
      assert.ok(list !== null, 'the list and its first item should both be stamped');
      assert.notEqual(list[1], list[2]);
    } finally { run.clean(); }
  }
});

test('a document token is derived from the name, and a collision is broken deterministically', () => {
  const tokens = documentTokens(['EPUB/text/ch-1.xhtml', 'EPUB/text/ch1.xhtml', 'EPUB/x/c0002.xhtml']);
  assert.equal(tokens.get('EPUB/x/c0002.xhtml'), 'c0002');
  // Two names that reduce to the same token. The tie is broken by the members'
  // own sorted order, which is a property of the book and not of the run.
  assert.equal(tokens.get('EPUB/text/ch-1.xhtml'), 'ch1');
  assert.equal(tokens.get('EPUB/text/ch1.xhtml'), 'ch1-2');
  // The same answer whatever order the spine happens to list them in.
  assert.deepEqual(
    [...documentTokens(['EPUB/text/ch1.xhtml', 'EPUB/text/ch-1.xhtml'])].sort(),
    [...documentTokens(['EPUB/text/ch-1.xhtml', 'EPUB/text/ch1.xhtml'])].sort(),
  );
});

test('an id the book already carries is never minted a second time', async () => {
  const chapter = PUBLISHER_TWO.replace('<h1>', '<h1 data-bf-id="cch02-1">');
  const run = await stamp(publisherEpub(withoutPagebreaks(PUBLISHER_ONE), chapter));
  try {
    const all = idsOf(run.two);
    assert.equal(new Set(all).size, all.length);
    assert.equal(all[0], 'cch02-1');
    assert.equal(all[1], 'cch02-2');
    assert.equal(run.report.alreadyNamed, 1);
  } finally { run.clean(); }
});

// ── only what is missing ─────────────────────────────────────────────────────

test('a cast book that predates data-bf-id gains ids and nothing else', async () => {
  const run = await stamp(foundryEpub());
  try {
    const chapter = run.written.get(CHAPTER_PATH)!.text();
    // Not one new category: every block already said what it was.
    assert.deepEqual(run.report.stamped, {});
    assert.equal(run.report.alreadyStamped, 24);
    assert.equal(run.report.idsWritten, 24);
    // The emitter's own scheme, page-scoped and counting elements.
    assert.match(chapter, /<h1 data-bf-page="7" data-bf-cat="chapter" data-bf-id="p7-1">/);
    assert.match(chapter, /<ul data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-2">/);
    assert.match(chapter, /<li data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-3">/);
    // And the categories it arrived with are exactly the categories it leaves
    // with — a value corrected by hand in the inspector is not this pass's to
    // overrule.
    const before = unzipMap(foundryEpub()).get(CHAPTER_PATH)!.text();
    const cats = (text: string): string[] => [...text.matchAll(/data-bf-cat="([^"]*)"/g)].map((m) => m[1]!);
    assert.deepEqual(cats(chapter), cats(before));
  } finally { run.clean(); }
});

test('running it twice changes nothing the second time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, publisherEpub());
    const first = await epubStamp({ epubPath: tree, log: quiet });
    assert.ok(first.idsWritten > 0);
    assert.equal(first.documentsWritten, 2);

    const after = new Map<string, string>();
    for (const member of [PUBLISHER_ONE_PATH, PUBLISHER_TWO_PATH, NAV_PATH, OPF_PATH]) {
      after.set(member, fs.readFileSync(path.join(tree, ...member.split('/')), 'utf8'));
    }

    const second = await epubStamp({ epubPath: tree, log: quiet });
    assert.equal(second.idsWritten, 0);
    assert.equal(second.documentsWritten, 0);
    assert.deepEqual(second.stamped, {});
    for (const [member, text] of after) {
      assert.equal(fs.readFileSync(path.join(tree, ...member.split('/')), 'utf8'), text, member);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the members nobody stamped come back byte-identical, mimetype first and stored', async () => {
  const book = publisherEpub();
  const run = await stamp(book);
  try {
    const before = unzipMap(book);
    for (const untouched of ['mimetype', 'META-INF/container.xml', 'EPUB/style.css', 'EPUB/images/plate.png', OPF_PATH, NAV_PATH]) {
      assert.deepEqual(
        [...run.written.get(untouched)!.data],
        [...before.get(untouched)!.data],
        `${untouched} was rewritten and nothing asked it to be`,
      );
    }
    assert.notEqual(run.one, before.get(PUBLISHER_ONE_PATH)!.text());
  } finally { run.clean(); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    const out = path.join(dir, 'Buch.stamped.epub');
    fs.writeFileSync(epub, book);
    await epubStamp({ epubPath: epub, outPath: out, log: quiet });
    const entries = unzip(new Uint8Array(fs.readFileSync(out)));
    assert.equal(entries[0].path, 'mimetype');
    assert.equal(entries[0].method, 0);
    assert.equal(entries[0].text(), 'application/epub+zip');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a working tree is stamped in place and nothing else in it is touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, publisherEpub());
    const css = path.join(tree, 'EPUB', 'style.css');
    const before = fs.readFileSync(css, 'utf8');
    const report = await epubStamp({ epubPath: tree, log: quiet });
    assert.equal(report.inPlace, true);
    assert.equal(report.outPath, tree);
    assert.match(fs.readFileSync(path.join(tree, ...PUBLISHER_ONE_PATH.split('/')), 'utf8'), /data-bf-cat="chapter"/);
    assert.equal(fs.readFileSync(css, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the point of the whole thing ─────────────────────────────────────────────

test("a publisher's EPUB is refused today and admitted once it has been stamped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    const stamped = path.join(dir, 'Buch.stamped.epub');
    fs.writeFileSync(epub, plainEpub());

    // Before: the admission rule refuses it by name, so `translate` and
    // `epub-final` both refuse it.
    assert.throws(
      () => readFoundryBook(new Uint8Array(fs.readFileSync(epub))),
      (error: Error) => error instanceof BookError && /not a foundry-converted book/.test(error.message),
    );

    // One paragraph, and the default rule is what read it.
    const report = await epubStamp({ epubPath: epub, outPath: stamped, log: quiet });
    assert.deepEqual(report.stamped, { text: 1 });
    assert.equal(report.byLayer.default, 1);

    // After: admitted, and the edition can be built from it.
    const book = readFoundryBook(new Uint8Array(fs.readFileSync(stamped)));
    assert.equal(book.documents.length, 1);
    assert.equal(book.documents[0].stamped, true);

    const final = await epubFinal({
      epubPath: stamped,
      outPath: path.join(dir, 'Buch.final.epub'),
      log: quiet,
    });
    assert.equal(final.cuts, 0);
    assert.equal(final.documents, 1);
    // `epub-final` strips the ids it means nothing outside this app, and keeps
    // the category — so the book it wrote is still a foundry book.
    const edition = unzipMap(new Uint8Array(fs.readFileSync(path.join(dir, 'Buch.final.epub'))));
    assert.doesNotMatch(edition.get(CHAPTER_PATH)!.text(), /data-bf-id/);
    assert.match(edition.get(CHAPTER_PATH)!.text(), /data-bf-cat="text"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a whole publisher book comes out of epub-final as an edition', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    const stamped = path.join(dir, 'Buch.stamped.epub');
    fs.writeFileSync(epub, publisherEpub());
    await epubStamp({ epubPath: epub, outPath: stamped, log: quiet });
    const report = await epubFinal({
      epubPath: stamped,
      outPath: path.join(dir, 'Buch.final.epub'),
      log: quiet,
    });
    assert.equal(report.cuts, 0);
    assert.equal(report.imagesDropped.length, 0);
    assert.equal(report.navRemoved, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every category this writes is one the translator has a rule for', async () => {
  const known = new Set([...TRANSLATED_CATEGORIES, ...SKIPPED_CATEGORIES]);
  const books = [
    publisherEpub(),
    publisherEpub(withoutPagebreaks(PUBLISHER_ONE), PUBLISHER_TITLE_PAGE),
    plainEpub(),
  ];
  for (const book of books) {
    const run = await stamp(book);
    try {
      for (const category of Object.keys(run.report.stamped)) {
        // `blocks.ts` refuses a whole book BY NAME over a category it has no
        // rule for, so a stamp outside the eleven would turn "this book can now
        // be translated" into a book that cannot be translated at all.
        assert.ok(known.has(category), `data-bf-cat="${category}" is not a category blocks.ts knows`);
      }
    } finally { run.clean(); }
  }
});

// ── the refusals ─────────────────────────────────────────────────────────────

test('an input that cannot be read is refused by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const missing = path.join(dir, 'nothing-here.epub');
    await assert.rejects(
      epubStamp({ epubPath: missing, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof StampError && error.message.includes(missing),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a directory that is not an unpacked EPUB is refused by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'project.json'), '{}');
    await assert.rejects(
      epubStamp({ epubPath: project, log: quiet }),
      (error: Error) => error instanceof StampError
        && error.message.includes(project)
        && /mimetype/.test(error.message),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a ZIP that is not an EPUB, and an EPUB with no spine, are each refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const notEpub = path.join(dir, 'notes.zip');
    fs.writeFileSync(notEpub, writeZip([zipText('notes.txt', 'nothing to see')]));
    await assert.rejects(
      epubStamp({ epubPath: notEpub, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof BookError && /it is not an EPUB/.test(error.message),
    );

    const empty = path.join(dir, 'empty.epub');
    fs.writeFileSync(empty, writeZip([
      zipText('mimetype', 'application/epub+zip'),
      zipText('META-INF/container.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        + `  <rootfiles><rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/></rootfiles>\n`
        + '</container>\n'),
      zipText(OPF_PATH,
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">\n'
        + '  <metadata/><manifest/><spine/>\n</package>\n'),
    ]));
    await assert.rejects(
      epubStamp({ epubPath: empty, outPath: path.join(dir, 'out2.epub'), log: quiet }),
      (error: Error) => error instanceof BookError && /empty spine/.test(error.message),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file with no --out is refused, and a directory WITH one is refused too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    fs.writeFileSync(epub, publisherEpub());
    await assert.rejects(
      epubStamp({ epubPath: epub, log: quiet }),
      (error: Error) => error instanceof StampError
        && error.message.includes(epub)
        && /foundry never writes over an input/.test(error.message),
    );
    // The input is untouched by the refusal — that is what the refusal is for.
    assert.deepEqual([...new Uint8Array(fs.readFileSync(epub))], [...publisherEpub()]);

    const tree = path.join(dir, 'working');
    unpackTo(tree, publisherEpub());
    await assert.rejects(
      epubStamp({ epubPath: tree, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof StampError && /stamped in place/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(dir, 'out.epub')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a path that is neither a file nor a directory is refused by name', async () => {
  // A device node — the case `readEpubInput`'s own walk names for members.
  const device = process.platform === 'win32' ? null : '/dev/null';
  if (device === null) return;
  await assert.rejects(
    epubStamp({ epubPath: device, outPath: 'out.epub', log: quiet }),
    (error: Error) => error instanceof StampError && /neither a file nor a directory/.test(error.message),
  );
});

// ── the command surface ──────────────────────────────────────────────────────

const command = findCommand('epub-stamp')!;

test('the command is registered with its two flags', () => {
  assert.ok(command !== undefined);
  assert.deepEqual((command.options ?? []).map((o) => o.name).sort(), ['epub', 'out']);
});

test('--out equal to --epub is refused before a byte is read', async () => {
  await assert.rejects(
    runCommand(command, ['--epub', 'books/Buch.epub', '--out', 'books/Buch.epub']),
    (error: Error) => error instanceof UsageError && /is the input itself/.test(error.message),
  );
  await assert.rejects(
    runCommand(command, ['--epub', 'books/working', '--out', 'books/./working']),
    UsageError,
  );
});

test('a missing --epub is refused by name, and --out alone is not required', async () => {
  await assert.rejects(runCommand(command, ['--out', 'stamped.epub']), UsageError);
});

test('the help says what each layer decides and what is never invented', () => {
  assert.match(command.detail, /A DIRECTORY IS STAMPED IN PLACE and a FILE IS NOT/);
  assert.match(command.detail, /ONLY WHAT IS MISSING IS WRITTEN/);
  assert.match(command.detail, /THE CATEGORY IS INFERRED IN LAYERS, MOST CERTAIN FIRST/);
  assert.match(command.detail, /AN ELEMENT MATCHING NONE OF THESE IS NOT STAMPED/);
  assert.match(command.detail, /PAGE PROVENANCE IS KEPT AND NEVER INVENTED/);
});

test('the report line the app parses carries its three numbers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-stamp-'));
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const said = process.stdout.write.bind(process.stdout);
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, publisherEpub());
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    (process.stdout as NodeJS.WriteStream).write = (() => true) as typeof process.stdout.write;
    await runCommand(command, ['--epub', tree]);
  } finally {
    (process.stderr as NodeJS.WriteStream).write = write;
    (process.stdout as NodeJS.WriteStream).write = said;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const all = lines.join('');
  // The three phrases app/electron/engine.ts reads off this line. Changing any
  // of them silently stops the app reloading a chapter it just stamped.
  assert.match(all, /epub-stamp: 3 documents, \d+ blocks stamped, \d+ ids written/);
  assert.match(all, /by declaration \d+, by shape \d+, by position \d+, by default \d+/);
});
