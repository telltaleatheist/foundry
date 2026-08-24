/**
 * A tiny foundry EPUB, and a translator that is not a language model.
 *
 * The book is built with the same writer the real emitter uses
 * (`src/export/zip.ts`) and carries one of every shape the translator has to
 * cope with: a chapter opening with a page-break span inside the heading,
 * emphasis, a footnote reference anchored to a note at the end of the file, a
 * list whose `<ul>` and `<li>` are BOTH stamped, a quote whose `<blockquote>`
 * and inner `<p>` are both stamped, and one each of the categories that must
 * come out untouched.
 *
 * IT IS EXTENDED, NEVER REPLACED. Every element that was here when a test was
 * written is still here, in the same order, so an assertion that pinned the
 * one-item list or the single-cell table still means what its author meant. The
 * shapes added for chunking sit AFTER them: a six-item list that is one request,
 * a three-paragraph blockquote, a real table with a header row and an empty
 * cell, and a table with a `|` in a cell that no pipe rendering can carry.
 *
 * AND ONE BOOK THAT IS NOT OURS AT ALL. `publisherEpub()` at the end of this
 * file is a born-digital EPUB carrying not a single foundry attribute — the
 * input `foundry epub-stamp` exists for, and the negative case for the
 * admission rule in `book.ts`. `plainEpub()` above it is the same idea reduced
 * to one paragraph, and it is deliberately left exactly as it was: several
 * refusal tests are pinned to it.
 *
 * The fake translator uppercases the words and leaves the markers alone. That
 * is enough to be a real translation as far as every mechanical check is
 * concerned — it is not empty, not the source, the same length, and carries
 * every marker exactly once — while staying readable in an assertion.
 */
import { writeZip, zipText } from '../../src/export/zip.js';
import type { HttpResponse, Transport } from '../../src/translate/ollama.js';

export const CHAPTER_PATH = 'EPUB/text/c0001.xhtml';
export const OPF_PATH = 'EPUB/package.opf';
export const NAV_PATH = 'EPUB/nav.xhtml';

export const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head>
  <meta charset="utf-8"/>
  <title>Der Staat</title>
</head>
<body>
<h1 data-bf-page="7" data-bf-cat="chapter"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"></span>Der Staat</h1>
<p data-bf-page="7" data-bf-cat="text">Ein <em>voelkischer</em> Staat war das Ziel<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a> der ganzen Bewegung.</p>
<h2 id="sh1" data-bf-page="8" data-bf-cat="section-header">Die Ordnung</h2>
<ul data-bf-page="8" data-bf-cat="list-item">
  <li data-bf-page="8" data-bf-cat="list-item">Erstens kommt die Ordnung im Lande.</li>
</ul>
<blockquote data-bf-page="8" data-bf-cat="quote"><p data-bf-page="8" data-bf-cat="quote">Ein langes Zitat steht hier im Buch.</p></blockquote>
<div class="tablewrap" data-bf-page="9" data-bf-cat="table"><table><tr><td>Jahr</td><td>Zahl</td></tr></table></div>
<p class="formula" data-bf-page="9" data-bf-cat="formula">a = b + c</p>
<figure data-bf-page="9" data-bf-cat="picture"><img src="../images/p0009-1.png" alt="figure from page 9"/></figure>
<p class="caption" data-bf-page="9" data-bf-cat="caption">Abbildung des grossen Gebaeudes.</p>
<h2 id="sh2" data-bf-page="10" data-bf-cat="section-header">Die Punkte</h2>
<ul data-bf-page="10" data-bf-cat="list-item">
  <li data-bf-page="10" data-bf-cat="list-item">Erstens die Aufhebung der Vertraege.</li>
  <li data-bf-page="10" data-bf-cat="list-item">Zweitens die <em>Gleichschaltung</em> der Laender.</li>
  <li data-bf-page="10" data-bf-cat="list-item">Drittens die Ordnung des Berufsstandes.</li>
  <li data-bf-page="10" data-bf-cat="list-item">Viertens die <em>Frage</em> des Bodens.</li>
</ul>
<blockquote data-bf-page="11" data-bf-cat="quote"><p data-bf-page="11" data-bf-cat="quote">Der erste Absatz des langen Zitates.</p><p data-bf-page="11" data-bf-cat="quote">Der zweite Absatz des langen Zitates.</p><p data-bf-page="11" data-bf-cat="quote">Der dritte Absatz des langen Zitates.</p></blockquote>
<div class="tablewrap" data-bf-page="12" data-bf-cat="table"><table><tr><th>Jahr</th><th>Mitglieder</th><th>Bemerkung</th></tr><tr><td>1931</td><td>1.200</td><td>Der erste Bericht</td></tr><tr><td>1932</td><td>3.400</td><td></td></tr></table></div>
<div class="tablewrap" data-bf-page="13" data-bf-cat="table"><table><tr><td>Nord | Sued</td><td>Zahlen</td></tr><tr><td>Ost</td><td>West</td></tr></table></div>
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="9" data-bf-cat="footnote"><sup>1</sup> Siehe dazu das Werk von gestern.</aside>
</section>
</body>
</html>
`;

/**
 * The same book after somebody has been through it with select mode.
 *
 * A SEPARATE CHAPTER, NOT AN EDITED `CHAPTER`. Every assertion in the translate
 * suite is pinned to the shapes above — thirty blocks in sixteen requests, one
 * one-item list, one single-cell table — and marking six of them cut would move
 * every one of those numbers. This carries the same shapes plus the things a
 * cast book has that `CHAPTER` predates: `data-bf-id` on every element,
 * `data-bf-src` beside it and `data-bf-note` on every aside, a page marker at
 * the top of EVERY page rather than only the first, and a second footnote that
 * no marker in the prose ever claimed.
 *
 * THE `data-bf-src` VALUES ARE NOT DECORATION. A container and its child name
 * the SAME banked answer (`8:1` on the `<ul>` and its `<li>`, `8:2` on the
 * quote and its `<p>`), because one block of the book is one decision about all
 * of its elements — and the two asides share `9:3`, which is the whole reason
 * `data-bf-note` exists: one Footnote answer split into two notes, which `src`
 * alone could never tell apart. All four attributes are addressed to this
 * program and none of them may reach an edition.
 *
 * The marks are chosen so that one of each dangling case is exercised:
 *
 *  - `p7-2` carries the ONLY reference to `fn1`, so the note is orphaned;
 *  - `sh1` is what a contents entry points at, while `#nowhere` beside it is a
 *    pre-existing dangling entry that must survive untouched;
 *  - the `<ul>` is cut whole and takes its `<li>` with it;
 *  - the `<figure>` is the only thing referencing the book's one image;
 *  - `sh1`, `sh2` and `p11-1` each open their page and so each carry that
 *    page's marker: page 8 and page 10 have other blocks to re-home to, and
 *    page 11 has none at all, so its page really is gone.
 *
 * `fn2` and the plain `<sup>3</sup>` in `p7-3` are here to be LEFT ALONE — an
 * unmatched marker and an unreferenced note are facts about the scan, not
 * wreckage a cut made, and they are what the integrity report counts.
 */
export const CUT_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head>
  <meta charset="utf-8"/>
  <title>Der Staat</title>
</head>
<body>
<h1 data-bf-page="7" data-bf-cat="chapter" data-bf-id="p7-1" data-bf-src="7:0"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"></span>Der Staat</h1>
<p data-bf-page="7" data-bf-cat="text" data-bf-id="p7-2" data-bf-src="7:1" data-bf-cut="1">Ein <em>voelkischer</em> Staat war das Ziel<a id="ref-fn1" class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a> der ganzen Bewegung.</p>
<p data-bf-page="7" data-bf-cat="text" data-bf-id="p7-3" data-bf-src="7:2">Ein Absatz mit einer Ziffer<sup>3</sup>, zu der keine Note gefunden wurde.</p>
<h2 id="sh1" data-bf-page="8" data-bf-cat="section-header" data-bf-id="p8-1" data-bf-src="8:0" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-8" data-bf-page="8" aria-label="8"></span>Die Ordnung</h2>
<ul data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-2" data-bf-src="8:1" data-bf-cut="1">
  <li data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-3" data-bf-src="8:1">Erstens kommt die Ordnung im Lande.</li>
</ul>
<blockquote data-bf-page="8" data-bf-cat="quote" data-bf-id="p8-4" data-bf-src="8:2"><p data-bf-page="8" data-bf-cat="quote" data-bf-id="p8-5" data-bf-src="8:2">Ein langes Zitat steht hier im Buch.</p></blockquote>
<div class="tablewrap" data-bf-page="9" data-bf-cat="table" data-bf-id="p9-1" data-bf-src="9:0"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-9" data-bf-page="9" aria-label="9"></span><table><tr><td>Jahr</td><td>Zahl</td></tr></table></div>
<figure data-bf-page="9" data-bf-cat="picture" data-bf-id="p9-2" data-bf-src="9:1" data-bf-cut="1"><img src="../images/p0009-1.png" alt="figure from page 9"/></figure>
<p class="caption" data-bf-page="9" data-bf-cat="caption" data-bf-id="p9-3" data-bf-src="9:2">Abbildung des grossen Gebaeudes.</p>
<h2 id="sh2" data-bf-page="10" data-bf-cat="section-header" data-bf-id="p10-1" data-bf-src="10:0" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-10" data-bf-page="10" aria-label="10"></span>Die Punkte</h2>
<p data-bf-page="10" data-bf-cat="text" data-bf-id="p10-2" data-bf-src="10:1">Ein Absatz auf derselben Seite, der bleibt.</p>
<p data-bf-page="11" data-bf-cat="text" data-bf-id="p11-1" data-bf-src="11:0" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-11" data-bf-page="11" aria-label="11"></span>Die ganze Seite elf steht in einem Absatz.</p>
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="9" data-bf-cat="footnote" data-bf-id="p9-4" data-bf-src="9:3" data-bf-note="0"><a class="fn-back" epub:type="backlink" role="doc-backlink" href="#ref-fn1"><sup>1</sup></a> Siehe dazu das Werk von gestern.</aside>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn2" data-bf-page="9" data-bf-cat="footnote" data-bf-id="p9-5" data-bf-src="9:3" data-bf-note="1"><sup>2</sup> Eine Note, auf die nichts zeigt.</aside>
</section>
</body>
</html>
`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der Staat</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/c0001.xhtml">Der Staat</a>
        <ol>
          <li><a href="text/c0001.xhtml#sh1">Die Ordnung</a></li>
          <li><a href="text/c0001.xhtml#nowhere">Ein Eintrag ohne Ziel</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>
`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="de">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:test</dc:identifier>
    <dc:title>Der Staat</dc:title>
    <dc:language>de</dc:language>
    <dc:creator>Ein Verfasser</dc:creator>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p0009-1.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>
`;

/** A one-pixel-ish PNG stand-in: bytes that must come back byte-identical. */
export const PICTURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 250, 251]);

export function foundryEpub(): Uint8Array {
  return foundryEpubWith(CHAPTER);
}

/**
 * The same book around a chapter of the caller's own.
 *
 * For the shapes that are about SIZE rather than about markup — a list long
 * enough to be cut by `CHUNK_CHARS` is two thousand characters of German, which
 * belongs in the test that measures it and not in a fixture every other test
 * has to read past.
 *
 * The nav is a parameter for the same reason and defaults to this file's, so
 * every caller written before it existed still builds exactly the book it
 * built: a test about what happens to a contents entry with sub-entries under
 * it needs a contents page that HAS one, and adding that shape to the default
 * nav would move the label list `book.test.ts` pins.
 */
export function foundryEpubWith(chapter: string, nav: string = NAV): Uint8Array {
  return writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
      + `  <rootfiles>\n`
      + `    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>\n`
      + `  </rootfiles>\n</container>\n`),
    zipText('EPUB/style.css', 'body { margin: 0 5%; }\n'),
    zipText(CHAPTER_PATH, chapter),
    { path: 'EPUB/images/p0009-1.png', data: PICTURE },
    zipText(NAV_PATH, nav),
    zipText(OPF_PATH, OPF),
  ]);
}

/** A chapter document wrapped round whatever body a test needs. */
export function chapterWith(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der Staat</title></head>
<body>
${body}
</body>
</html>
`;
}

/** An EPUB with no foundry stamps anywhere — a publisher's book. */
export function plainEpub(): Uint8Array {
  const opf = OPF.replace('<itemref idref="c1"/>', '<itemref idref="c1"/>');
  return writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
      + `  <rootfiles><rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/></rootfiles>\n`
      + `</container>\n`),
    zipText(CHAPTER_PATH,
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n`
      + `<head><title>Kapitel</title></head>\n<body><p>Ein Satz ohne jede Herkunft.</p></body></html>\n`),
    zipText(NAV_PATH, NAV),
    zipText(OPF_PATH, opf),
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// A publisher's book — the one `epub-stamp` exists for
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Two documents of a born-digital EPUB, carrying NOT ONE foundry attribute.
 *
 * Everything a reader of these needs to know about them is that the structure is
 * stated in the file's own vocabulary rather than in foundry's, and that one of
 * every layer of the inference is present ON PURPOSE:
 *
 *  - DECLARED: `epub:type="epigraph"` on a `<div>` that is not a `<blockquote>`,
 *    and `epub:type="endnote"` on an `<li>` inside an `<ol epub:type="endnotes">`
 *    — which is the case that proves apparatus suppression, because the shape
 *    layer would otherwise call that list a list of list-items;
 *  - SHAPE: a `<blockquote>` over two `<p>`s, a `<ul>` over two `<li>`s, a
 *    `<figure>` with an `<img>` and a `<figcaption>`, and a `<table>` inside the
 *    wrapper `dots-book.ts` emits;
 *  - POSITION: an `<h1>` opening the document and an `<h2>` after prose;
 *  - DEFAULT: plain `<p>`s.
 *
 * And two things that must come out UNSTAMPED: the `<section epub:type="chapter">`
 * wrapping the whole document, which is a container, and the `<div class="body">`
 * inside it, which is one too.
 *
 * The page markers are the `<span epub:type="pagebreak">` shape publishers use,
 * with the printed number in `title` on one and `aria-label` on the other,
 * because both are in the wild. The FIRST one precedes every block, so nothing
 * in this document is before the book's own pagination.
 */
export const PUBLISHER_ONE_PATH = 'EPUB/text/ch01.xhtml';
export const PUBLISHER_TWO_PATH = 'EPUB/text/ch02.xhtml';

export const PUBLISHER_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der erste Teil</title></head>
<body>
<section epub:type="chapter">
<div class="body">
<span epub:type="pagebreak" role="doc-pagebreak" id="pb-12" title="12"></span>
<h1>Der erste Teil</h1>
<p>Ein Absatz auf Seite zwoelf.<a epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a></p>
<div class="epi" epub:type="epigraph">Ein Sinnspruch am Anfang.</div>
<blockquote><p>Ein langes Zitat.</p><p>Und noch ein Satz darin.</p></blockquote>
<ul><li>Erstens die Ordnung.</li><li>Zweitens die Ruhe.</li></ul>
<figure><img src="../images/plate.png" alt="Tafel"/><figcaption>Die Tafel von gestern.</figcaption></figure>
<div class="tablewrap"><table><tr><td>Jahr</td><td>Zahl</td></tr></table></div>
<span epub:type="pagebreak" role="doc-pagebreak" id="pb-13" aria-label="13"></span>
<h2>Ein Abschnitt</h2>
<p>Ein Absatz auf Seite dreizehn.</p>
<section epub:type="footnotes">
<ol epub:type="endnotes">
<li epub:type="endnote" id="fn1">Die erste Note.</li>
</ol>
</section>
</div>
</section>
</body>
</html>
`;

/**
 * The second document, and it is deliberately DIFFERENT in two ways.
 *
 * It carries no page markers of its own, so its blocks prove that the page is
 * never carried across a document boundary; and its first document-level element
 * is an `<h1>` with prose under it, so its own chapter opener is decided
 * independently of the first document's. Its `<ul>` is what the uniqueness
 * assertion across documents rests on.
 */
export const PUBLISHER_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der zweite Teil</title></head>
<body>
<h1>Der zweite Teil</h1>
<p>Ein Absatz ohne jede Seitenangabe.</p>
<ul><li>Ein Punkt.</li><li>Noch ein Punkt.</li></ul>
</body>
</html>
`;

/** A leaf with nothing but headings on it — a half-title, in EPUB terms. */
export const PUBLISHER_TITLE_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Der Staat</title></head>
<body>
<h1>Der Staat</h1>
<h2>Eine Untersuchung</h2>
</body>
</html>
`;

/** The same document with its printed pagination taken out. */
export function withoutPagebreaks(chapter: string): string {
  return chapter.replace(/<span epub:type="pagebreak"[^>]*><\/span>\n?/g, '');
}

const PUBLISHER_NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="utf-8"/><title>Inhalt</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Inhalt</h1>
    <ol>
      <li><a href="text/ch01.xhtml">Der erste Teil</a></li>
      <li><a href="text/ch02.xhtml">Der zweite Teil</a></li>
    </ol>
  </nav>
</body>
</html>
`;

const PUBLISHER_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="de">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:publisher</dc:identifier>
    <dc:title>Der Staat</dc:title>
    <dc:language>de</dc:language>
    <dc:creator>Ein Verlag</dc:creator>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/ch01.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch02.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/plate.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
`;

/**
 * A publisher's EPUB: two documents, a nav that is ALSO IN THE SPINE, and not
 * one foundry attribute anywhere.
 *
 * The nav being in the spine is not padding. Real EPUBs put the contents page in
 * the reading order so a reader can turn to it, and it is the case that proves
 * the nav document is skipped whole — stamping a table of contents would outline
 * every chapter title in select mode and hand the translator each of them a
 * second time.
 */
export function publisherEpub(
  one: string = PUBLISHER_ONE,
  two: string = PUBLISHER_TWO,
): Uint8Array {
  return writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
      + `  <rootfiles><rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/></rootfiles>\n`
      + `</container>\n`),
    zipText('EPUB/style.css', 'body { margin: 0 5%; }\n'),
    zipText(PUBLISHER_ONE_PATH, one),
    zipText(PUBLISHER_TWO_PATH, two),
    { path: 'EPUB/images/plate.png', data: PICTURE },
    zipText(NAV_PATH, PUBLISHER_NAV),
    zipText(OPF_PATH, PUBLISHER_OPF),
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Packages — the one thing `epub-meta` edits
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A package document with everything a metadata edit has to survive.
 *
 * A SEPARATE PACKAGE, NOT AN EDITED `OPF`. Half the translate suite and most of
 * `final.test.ts` read the one above, and adding a refinement or a second
 * namespace to it would move counts those tests pin. This one carries, on
 * purpose, every shape the metadata command has an opinion about:
 *
 *  - a `dc:identifier` whose `id` is what `<package unique-identifier>` names,
 *    which is the link that must survive a rewrite of its text;
 *  - a `dc:creator` with an id and TWO `<meta refines="#creator1">` elements
 *    pointing at it, so orphaning can be asserted against something real —
 *    `file-as`, which goes stale when the name is corrected, and `role`, which
 *    does not;
 *  - a refinement of the TITLE as well, so the stale report is proved to name
 *    only the field that actually moved;
 *  - NO `dc:publisher` and NO `dc:date`, which is what a cast book looks like
 *    and is the whole of the insert-a-missing-element case;
 *  - a comment and a second namespace declaration, neither of which any edit
 *    may disturb — they are the cheapest possible proof that nothing was
 *    re-serialised.
 */
export const METADATA_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="de">
  <!-- Cast by foundry. This comment is here to come out exactly where it went in. -->
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="pub-id">urn:uuid:test-metadata</dc:identifier>
    <dc:title id="t1">Der Staat</dc:title>
    <dc:language>de</dc:language>
    <dc:creator id="creator1">Ein Verfasser</dc:creator>
    <meta refines="#creator1" property="file-as">Verfasser, Ein</meta>
    <meta refines="#creator1" property="role" scheme="marc:relators">aut</meta>
    <meta refines="#t1" property="title-type">main</meta>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p0009-1.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>
`;

/**
 * The same package indented with TABS and binding Dublin Core to a prefix that
 * is not `dc`.
 *
 * Both halves are real. An OPF written by a different toolchain indents with
 * tabs, and the prefix is only a convention — `xmlns:dcterms` is bound to
 * something else entirely, and a package is free to call the Dublin Core
 * namespace whatever it likes. A command that assumed `dc:` and two spaces
 * would write an element in an undeclared prefix at the wrong depth, and the
 * first symptom would be a reader refusing the book.
 */
export const METADATA_OPF_ODD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<package xmlns="http://www.idpf.org/2007/opf" xmlns:d="http://purl.org/dc/elements/1.1/"'
  + ' version="3.0" unique-identifier="uid">',
  '\t<metadata>',
  '\t\t<d:identifier id="uid">urn:isbn:9780000000000</d:identifier>',
  '\t\t<d:title>Der Staat</d:title>',
  '\t\t<d:language>de</d:language>',
  '\t</metadata>',
  '\t<manifest>',
  '\t\t<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  '\t\t<item id="style" href="style.css" media-type="text/css"/>',
  '\t\t<item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>',
  '\t\t<item id="img1" href="images/p0009-1.png" media-type="image/png"/>',
  '\t</manifest>',
  '\t<spine>',
  '\t\t<itemref idref="c1"/>',
  '\t</spine>',
  '</package>',
  '',
].join('\n');

/**
 * Two authors — the case `--creator` states a whole new list for.
 *
 * It used to be the case `--creator` could not mean anything about, and the
 * refusal it provoked is why this package exists. The flag repeats now, and the
 * list it builds REPLACES the set, so this package is what a run that names one
 * author has to remove the second one from — and say so.
 */
export const METADATA_OPF_TWO_CREATORS = METADATA_OPF.replace(
  '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n',
  '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n'
  + '    <dc:creator id="creator2">Ein Zweiter</dc:creator>\n',
);

/** `unique-identifier` naming an id no `dc:identifier` carries: a link already broken. */
export const METADATA_OPF_LOST_ID = METADATA_OPF.replace('unique-identifier="pub-id"', 'unique-identifier="nope"');

/** A package with no `<metadata>` at all. Invalid EPUB, and refused by name. */
export const METADATA_OPF_NO_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p0009-1.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>
`;

/**
 * The book of `foundryEpub()` around a package of the caller's own.
 *
 * Everything but the package is the same bytes as every other fixture book
 * here, which is what makes "no member but the OPF changed" an assertion worth
 * making: the picture and the stylesheet come back byte-identical or the writer
 * re-encoded something nobody asked it to.
 */
export function metadataEpub(opf: string = METADATA_OPF): Uint8Array {
  return writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
      + `  <rootfiles>\n`
      + `    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>\n`
      + `  </rootfiles>\n</container>\n`),
    zipText('EPUB/style.css', 'body { margin: 0 5%; }\n'),
    zipText(CHAPTER_PATH, CHAPTER),
    { path: 'EPUB/images/p0009-1.png', data: PICTURE },
    zipText(NAV_PATH, NAV),
    zipText(OPF_PATH, opf),
  ]);
}

const TOKEN = /⟦\/?[em]\d+⟧/g;

/** Uppercase everything that is not a marker. See this file's header. */
export function shout(text: string): string {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    out += text.slice(at, match.index).toUpperCase() + match[0];
    at = match.index + match[0].length;
  }
  return out + text.slice(at).toUpperCase();
}

export interface FakeServer extends Transport {
  /** Every user message the run sent, in order. */
  readonly asked: string[];
}

/**
 * An Ollama that is not one.
 *
 * `answer` decides what comes back for each request; the default shouts. The
 * attempt number is passed so a test can fail a block once and let the retry
 * through.
 */
export function fakeOllama(
  answer: (user: string, attempt: number) => string = (user) => shout(user),
  models: string[] = ['qwen3.8:27b'],
): FakeServer {
  const asked: string[] = [];
  const attempts = new Map<string, number>();
  return {
    asked,
    async get(url: string): Promise<HttpResponse> {
      if (!url.endsWith('/api/tags')) return { status: 404, body: '' };
      return { status: 200, body: JSON.stringify({ models: models.map((name) => ({ name })) }) };
    },
    async post(_url: string, body: string): Promise<HttpResponse> {
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const user = parsed.messages[parsed.messages.length - 1].content;
      asked.push(user);
      const attempt = (attempts.get(user) ?? 0) + 1;
      attempts.set(user, attempt);
      return { status: 200, body: JSON.stringify({ message: { content: answer(user, attempt) } }) };
    },
  };
}
