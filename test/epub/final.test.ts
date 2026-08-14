/**
 * The edition: what a cut removes, what it drags with it, and what it must
 * leave alone.
 *
 * Every test here drives the real command against the real writer and reads the
 * result back with `test/export/unzip.ts`, which shares no code with
 * `src/export/zip.ts` on purpose — a writer verified by its own reader proves
 * only that the two agree.
 *
 * The assertions that matter most are the NEGATIVE ones. A tidy that removes
 * something nobody asked it to is indistinguishable from a working command
 * until somebody opens the book: the contents entry that pointed nowhere before
 * the run, the note no marker ever claimed, the image no figure ever named and
 * the reference number the emitter deliberately refused to guess about are each
 * asserted to survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UsageError } from '../../src/args.js';
import { findCommand, runCommand } from '../../src/commands.js';
import { epubFinal, FinalError, type FinalReport } from '../../src/epub/final.js';
import { BookError } from '../../src/translate/book.js';
import { unzip, unzipMap, type UnzippedEntry } from '../export/unzip.js';
import {
  CHAPTER_PATH, CUT_CHAPTER, NAV_PATH, OPF_PATH,
  chapterWith, foundryEpub, foundryEpubWith, plainEpub,
} from '../translate/fixture.js';

const quiet = (): void => {};

interface Run {
  report: FinalReport;
  written: Map<string, UnzippedEntry>;
  chapter: string;
  nav: string;
  opf: string;
  clean: () => void;
}

/** Write the book to a scratch file, finish it, and read the edition back. */
async function finish(book: Uint8Array): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-final-'));
  const epub = path.join(dir, 'Buch.epub');
  const out = path.join(dir, 'Buch.final.epub');
  fs.writeFileSync(epub, book);
  const report = await epubFinal({ epubPath: epub, outPath: out, log: quiet });
  const written = unzipMap(new Uint8Array(fs.readFileSync(out)));
  return {
    report,
    written,
    chapter: written.get(CHAPTER_PATH)!.text(),
    nav: written.get(NAV_PATH)!.text(),
    opf: written.get(OPF_PATH)!.text(),
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const cutBook = (): Uint8Array => foundryEpubWith(CUT_CHAPTER);

// ── the cut itself ───────────────────────────────────────────────────────────

test('every marked element is gone, and a marked container takes its children', async () => {
  const run = await finish(cutBook());
  try {
    // The six marks: a paragraph, a heading a nav entry points at, a whole
    // list, a figure, a second heading, and the only block on its page.
    assert.equal(run.report.cuts, 6);
    assert.doesNotMatch(run.chapter, /voelkischer/);
    assert.doesNotMatch(run.chapter, /Die Ordnung/);
    assert.doesNotMatch(run.chapter, /Die Punkte/);
    assert.doesNotMatch(run.chapter, /Die ganze Seite elf/);
    assert.doesNotMatch(run.chapter, /<figure/);
    // The `<li>` was never marked itself: it went because its `<ul>` did.
    assert.doesNotMatch(run.chapter, /Erstens kommt die Ordnung/);
    assert.doesNotMatch(run.chapter, /<ul/);

    // And everything that was not marked is still here, in its own words.
    assert.match(run.chapter, /Ein langes Zitat steht hier im Buch/);
    assert.match(run.chapter, /Abbildung des grossen Gebaeudes/);
    assert.match(run.chapter, /Ein Absatz auf derselben Seite, der bleibt/);
    assert.match(run.chapter, /<table>/);
  } finally { run.clean(); }
});

test('the members nobody edited come back byte-identical', async () => {
  const book = cutBook();
  const run = await finish(book);
  try {
    const before = unzipMap(book);
    for (const untouched of ['mimetype', 'META-INF/container.xml', 'EPUB/style.css']) {
      assert.deepEqual(
        [...run.written.get(untouched)!.data],
        [...before.get(untouched)!.data],
        `${untouched} was rewritten and nothing asked it to be`,
      );
    }
    // The three that a cut required, and no others.
    assert.notEqual(run.chapter, before.get(CHAPTER_PATH)!.text());
    assert.notEqual(run.nav, before.get(NAV_PATH)!.text());
    assert.notEqual(run.opf, before.get(OPF_PATH)!.text());
  } finally { run.clean(); }
});

test('mimetype leads the archive, stored, as the OCF spec requires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-final-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    const out = path.join(dir, 'Buch.final.epub');
    fs.writeFileSync(epub, cutBook());
    await epubFinal({ epubPath: epub, outPath: out, log: quiet });
    const entries = unzip(new Uint8Array(fs.readFileSync(out)));
    assert.equal(entries[0].path, 'mimetype');
    assert.equal(entries[0].method, 0);
    assert.equal(entries[0].text(), 'application/epub+zip');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the editing attributes are stripped and the page provenance is kept', async () => {
  const run = await finish(cutBook());
  try {
    for (const source of [run.chapter, run.nav, run.opf]) {
      assert.doesNotMatch(source, /data-bf-cut/);
      assert.doesNotMatch(source, /data-bf-id/);
    }
    // KEPT: the page, the category and the pagebreak spans. Page provenance is
    // what makes a scan citable and is what every later pass reads.
    assert.match(run.chapter, /<h1 data-bf-page="7" data-bf-cat="chapter">/);
    assert.match(run.chapter, /data-bf-cat="footnote"/);
    assert.match(run.chapter, /<span epub:type="pagebreak" role="doc-pagebreak" id="pb-7"/);
  } finally { run.clean(); }
});

// ── the footnotes ────────────────────────────────────────────────────────────

test('a note whose only reference was cut goes; one nothing ever pointed at stays', async () => {
  const run = await finish(cutBook());
  try {
    assert.equal(run.report.notesDropped, 1);
    assert.doesNotMatch(run.chapter, /id="fn1"/);
    assert.doesNotMatch(run.chapter, /Siehe dazu das Werk von gestern/);
    // fn2 never had a marker claiming it. That is a fact about the scan —
    // `dots-book.ts` refuses to guess which note an unmatched number belongs to
    // — and this run did not create it, so it is counted and left alone.
    assert.match(run.chapter, /id="fn2"/);
    assert.match(run.chapter, /Eine Note, auf die nichts zeigt/);
    assert.equal(run.report.unreferencedNotes, 1);
  } finally { run.clean(); }
});

test('a footnotes section left holding nothing but its rule is removed', async () => {
  const run = await finish(foundryEpubWith(chapterWith(
    `<p data-bf-page="3" data-bf-cat="text" data-bf-cut="1">Ein Satz`
    + `<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a>.</p>
<p data-bf-page="3" data-bf-cat="text">Ein Satz, der bleibt.</p>
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="3" data-bf-cat="footnote"><sup>1</sup> Die einzige Note.</aside>
</section>`,
  )));
  try {
    assert.equal(run.report.notesDropped, 1);
    assert.equal(run.report.noteSectionsDropped, 1);
    assert.doesNotMatch(run.chapter, /footnotes/);
    assert.doesNotMatch(run.chapter, /<hr\/>/);
    assert.match(run.chapter, /Ein Satz, der bleibt/);
  } finally { run.clean(); }
});

test('a reference whose note was cut keeps its number and loses its link', async () => {
  const run = await finish(foundryEpubWith(chapterWith(
    `<p data-bf-page="3" data-bf-cat="text">Ein Satz`
    + `<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a> und mehr.</p>
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="3" data-bf-cat="footnote" data-bf-cut="1"><sup>1</sup> Die Note.</aside>
</section>`,
  )));
  try {
    assert.equal(run.report.noterefsDemoted, 1);
    // The number is printed on the page, so it stays; only the link goes.
    assert.match(run.chapter, /Ein Satz<sup>1<\/sup> und mehr\./);
    assert.doesNotMatch(run.chapter, /noteref/);
    assert.equal(run.report.noterefs, 0);
    assert.equal(run.report.unlinkedMarkers, 1);
  } finally { run.clean(); }
});

// ── the contents ─────────────────────────────────────────────────────────────

test('the entry for a cut heading goes, and the one that never resolved stays', async () => {
  const run = await finish(cutBook());
  try {
    assert.equal(run.report.navRemoved, 1);
    assert.doesNotMatch(run.nav, /#sh1/);
    assert.doesNotMatch(run.nav, /Die Ordnung/);
    // `#nowhere` was dangling before this run touched the book. It may be
    // hand-written and it is not wreckage a cut made.
    assert.match(run.nav, /#nowhere/);
    assert.match(run.nav, /Ein Eintrag ohne Ziel/);
    // The chapter's own entry, which points at a document with content left.
    assert.match(run.nav, /<a href="text\/c0001\.xhtml">Der Staat<\/a>/);
    // The sub-list still holds its surviving item rather than being emptied.
    assert.match(run.nav, /<ol>[\s\S]*#nowhere[\s\S]*<\/ol>/);
  } finally { run.clean(); }
});

test('an entry whose target is gone keeps its sub-entries by becoming a label', async () => {
  /*
   * The case that makes removing the whole `<li>` wrong. `Die Ordnung` was cut,
   * but the section under it was not — and a contents page that loses three
   * sub-sections because the heading above them was removed is describing a
   * shallower book than the one that was written. The EPUB nav grammar allows a
   * `<span>` exactly here: a label with no document of its own.
   */
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der Staat</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="text/c0001.xhtml#sh1">Die Ordnung</a>
        <ol>
          <li><a href="text/c0001.xhtml#sh2">Die Punkte</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>
`;
  const run = await finish(foundryEpubWith(chapterWith(
    '<h2 id="sh1" data-bf-page="8" data-bf-cat="section-header" data-bf-cut="1">Die Ordnung</h2>\n'
    + '<h2 id="sh2" data-bf-page="8" data-bf-cat="section-header">Die Punkte</h2>\n'
    + '<p data-bf-page="8" data-bf-cat="text">Ein Absatz, der bleibt.</p>',
  ), nav));
  try {
    // Nothing was REMOVED from the contents: the entry is still there, without
    // its link. The two counts are disjoint so that a run cannot report the
    // loss of an entry the book still has.
    assert.equal(run.report.navRemoved, 0);
    assert.equal(run.report.navDemoted, 1);
    assert.match(run.nav, /<span>Die Ordnung<\/span>/);
    assert.doesNotMatch(run.nav, /#sh1/);
    assert.match(run.nav, /<a href="text\/c0001\.xhtml#sh2">Die Punkte<\/a>/);
  } finally { run.clean(); }
});

// ── the pictures ─────────────────────────────────────────────────────────────

test('an image no figure points at any more leaves the package and the manifest', async () => {
  const run = await finish(cutBook());
  try {
    assert.deepEqual(run.report.imagesDropped, ['EPUB/images/p0009-1.png']);
    assert.equal(run.written.has('EPUB/images/p0009-1.png'), false);
    assert.doesNotMatch(run.opf, /p0009-1\.png/);
    assert.doesNotMatch(run.opf, /id="img1"/);
    // Only that item: the nav, the stylesheet and the chapter are still declared.
    assert.match(run.opf, /id="nav"/);
    assert.match(run.opf, /id="style"/);
    assert.match(run.opf, /id="c1"/);
  } finally { run.clean(); }
});

test('an image the book never pointed at is left exactly where it is', async () => {
  const run = await finish(foundryEpubWith(chapterWith(
    '<p data-bf-page="3" data-bf-cat="text" data-bf-cut="1">Ein Satz, der geht.</p>\n'
    + '<p data-bf-page="3" data-bf-cat="text">Ein Satz, der bleibt.</p>',
  )));
  try {
    // This chapter has no `<figure>` at all, so the image was dead weight
    // BEFORE the run. Dropping it would be a decision nobody ordered.
    assert.deepEqual(run.report.imagesDropped, []);
    assert.equal(run.written.has('EPUB/images/p0009-1.png'), true);
    assert.match(run.opf, /p0009-1\.png/);
  } finally { run.clean(); }
});

// ── the pagination ───────────────────────────────────────────────────────────

test('a page marker re-homes to the next surviving block on its page', async () => {
  const run = await finish(cutBook());
  try {
    assert.deepEqual(run.report.pagesRehomed, ['8', '10']);
    /*
     * Page 8 opened on the cut `<h2>`, and the `<ul>` after it was cut too. The
     * innermost surviving block on the page is the `<p>` inside the quote —
     * which is exactly where the emitter would have put the marker — and the
     * span arrives verbatim, id, role and aria-label intact.
     */
    assert.match(
      run.chapter,
      /<p data-bf-page="8" data-bf-cat="quote"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-8" data-bf-page="8" aria-label="8"><\/span>Ein langes Zitat/,
    );
    assert.match(
      run.chapter,
      /<p data-bf-page="10" data-bf-cat="text"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-10"[^>]*><\/span>Ein Absatz auf derselben Seite/,
    );
  } finally { run.clean(); }
});

test('a page with nothing left on it loses its marker, and the run says which page', async () => {
  const run = await finish(cutBook());
  try {
    assert.deepEqual(run.report.pagesLost, ['11']);
    assert.doesNotMatch(run.chapter, /pb-11/);
    // The pages that still have blocks keep theirs.
    for (const id of ['pb-7', 'pb-8', 'pb-9', 'pb-10']) assert.match(run.chapter, new RegExp(id));
  } finally { run.clean(); }
});

// ── the integrity report ─────────────────────────────────────────────────────

test('the integrity report counts what the finished book can prove', async () => {
  const run = await finish(cutBook());
  try {
    const { report } = run;
    assert.equal(report.documents, 1);
    // The only reference number that linked to a note was in the cut paragraph.
    assert.equal(report.noterefs, 0);
    // `<sup>3</sup>` in the surviving paragraph: a printed marker the emitter
    // could not match to a note. Not a defect — no link beats a wrong one.
    assert.equal(report.unlinkedMarkers, 1);
    assert.equal(report.notes, 1);
    assert.equal(report.unreferencedNotes, 1);
    // Cover support does not exist in the engine, so this reports the absence
    // rather than pretending.
    assert.equal(report.cover, false);
  } finally { run.clean(); }
});

test('a book with no cuts in it comes out as itself, counted', async () => {
  const run = await finish(foundryEpub());
  try {
    const { report } = run;
    assert.equal(report.cuts, 0);
    assert.equal(report.notesDropped, 0);
    assert.equal(report.navRemoved, 0);
    assert.deepEqual(report.imagesDropped, []);
    assert.deepEqual(report.pagesLost, []);
    // The book's own integrity, unchanged by anything this command did.
    assert.equal(report.noterefs, 1);
    assert.equal(report.notes, 1);
    assert.equal(report.unreferencedNotes, 0);
    assert.equal(report.unlinkedMarkers, 0);
    // The chapter is untouched but for the stamps that mean nothing outside
    // this program — and this fixture carries none of them, so it is untouched.
    assert.equal(run.chapter, unzipMap(foundryEpub()).get(CHAPTER_PATH)!.text());
    assert.equal(run.nav, unzipMap(foundryEpub()).get(NAV_PATH)!.text());
  } finally { run.clean(); }
});

// ── the unpacked working tree ────────────────────────────────────────────────

test('a directory of an unpacked EPUB is finished exactly as the file is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-final-'));
  try {
    const tree = path.join(dir, 'working');
    for (const entry of unzip(cutBook())) {
      const full = path.join(tree, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.data);
    }

    const out = path.join(dir, 'Buch.final.epub');
    const report = await epubFinal({ epubPath: tree, outPath: out, log: quiet });
    const written = unzipMap(new Uint8Array(fs.readFileSync(out)));

    const fromFile = await finish(cutBook());
    try {
      assert.equal(written.get(CHAPTER_PATH)!.text(), fromFile.chapter);
      assert.equal(written.get(NAV_PATH)!.text(), fromFile.nav);
      assert.equal(written.get(OPF_PATH)!.text(), fromFile.opf);
      assert.deepEqual(report, { ...fromFile.report, outPath: out });
      assert.equal(unzip(new Uint8Array(fs.readFileSync(out)))[0].path, 'mimetype');
    } finally { fromFile.clean(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the refusals ─────────────────────────────────────────────────────────────

test('an EPUB without foundry stamps is refused, and the sentence says what for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-final-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    fs.writeFileSync(epub, plainEpub());
    await assert.rejects(
      epubFinal({ epubPath: epub, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof BookError
        && /not a foundry-converted book/.test(error.message)
        && /a mark sits on the categories foundry stamps/.test(error.message),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an input that cannot be read is refused by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-final-'));
  try {
    const missing = path.join(dir, 'nothing-here.epub');
    await assert.rejects(
      epubFinal({ epubPath: missing, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof FinalError && error.message.includes(missing),
    );

    // A directory that is not an unpacked EPUB — a project folder, a library
    // root, the parent of the working tree. Named, rather than read as a book.
    const notABook = path.join(dir, 'project');
    fs.mkdirSync(notABook);
    fs.writeFileSync(path.join(notABook, 'project.json'), '{}');
    await assert.rejects(
      epubFinal({ epubPath: notABook, outPath: path.join(dir, 'out.epub'), log: quiet }),
      (error: Error) => error instanceof FinalError
        && error.message.includes(notABook)
        && /mimetype/.test(error.message),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the command surface ──────────────────────────────────────────────────────

const command = findCommand('epub-final')!;

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

test('a missing --epub or --out is refused by name', async () => {
  await assert.rejects(runCommand(command, ['--out', 'final.epub']), UsageError);
  await assert.rejects(runCommand(command, ['--epub', 'Buch.epub']), UsageError);
});

test('the help says what is kept, what is stripped, and what is never removed', () => {
  assert.match(command.detail, /--epub TAKES A DIRECTORY AS WELL AS A FILE/);
  assert.match(command.detail, /TWO ATTRIBUTES ARE STRIPPED AND TWO ARE KEPT/);
  assert.match(command.detail, /A PAGE MARKER IS RE-HOMED RATHER THAN LOST/);
  assert.match(command.detail, /THE FILE IS WRITTEN ANYWAY/);
  // The rule that keeps this command honest: it tidies what THIS run orphaned.
  assert.match(command.detail, /pointed nowhere BEFORE the run is left exactly as it was/);
  // The cover line moved from "nothing writes one yet" to what a missing one
  // now MEANS, because vlm-convert writes one and the old sentence would send
  // somebody looking for a feature that is there.
  assert.match(command.detail, /vlm-convert --format epub writes one/);
});
