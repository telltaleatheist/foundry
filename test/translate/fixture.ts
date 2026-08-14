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
 * every one of those numbers. This carries the same shapes plus the three
 * things a cast book has that `CHAPTER` predates: `data-bf-id` on every element,
 * a page marker at the top of EVERY page rather than only the first, and a
 * second footnote that no marker in the prose ever claimed.
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
<h1 data-bf-page="7" data-bf-cat="chapter" data-bf-id="p7-1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"></span>Der Staat</h1>
<p data-bf-page="7" data-bf-cat="text" data-bf-id="p7-2" data-bf-cut="1">Ein <em>voelkischer</em> Staat war das Ziel<a id="ref-fn1" class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1</sup></a> der ganzen Bewegung.</p>
<p data-bf-page="7" data-bf-cat="text" data-bf-id="p7-3">Ein Absatz mit einer Ziffer<sup>3</sup>, zu der keine Note gefunden wurde.</p>
<h2 id="sh1" data-bf-page="8" data-bf-cat="section-header" data-bf-id="p8-1" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-8" data-bf-page="8" aria-label="8"></span>Die Ordnung</h2>
<ul data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-2" data-bf-cut="1">
  <li data-bf-page="8" data-bf-cat="list-item" data-bf-id="p8-3">Erstens kommt die Ordnung im Lande.</li>
</ul>
<blockquote data-bf-page="8" data-bf-cat="quote" data-bf-id="p8-4"><p data-bf-page="8" data-bf-cat="quote" data-bf-id="p8-5">Ein langes Zitat steht hier im Buch.</p></blockquote>
<div class="tablewrap" data-bf-page="9" data-bf-cat="table" data-bf-id="p9-1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-9" data-bf-page="9" aria-label="9"></span><table><tr><td>Jahr</td><td>Zahl</td></tr></table></div>
<figure data-bf-page="9" data-bf-cat="picture" data-bf-id="p9-2" data-bf-cut="1"><img src="../images/p0009-1.png" alt="figure from page 9"/></figure>
<p class="caption" data-bf-page="9" data-bf-cat="caption" data-bf-id="p9-3">Abbildung des grossen Gebaeudes.</p>
<h2 id="sh2" data-bf-page="10" data-bf-cat="section-header" data-bf-id="p10-1" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-10" data-bf-page="10" aria-label="10"></span>Die Punkte</h2>
<p data-bf-page="10" data-bf-cat="text" data-bf-id="p10-2">Ein Absatz auf derselben Seite, der bleibt.</p>
<p data-bf-page="11" data-bf-cat="text" data-bf-id="p11-1" data-bf-cut="1"><span epub:type="pagebreak" role="doc-pagebreak" id="pb-11" data-bf-page="11" aria-label="11"></span>Die ganze Seite elf steht in einem Absatz.</p>
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="9" data-bf-cat="footnote" data-bf-id="p9-4"><a class="fn-back" epub:type="backlink" role="doc-backlink" href="#ref-fn1"><sup>1</sup></a> Siehe dazu das Werk von gestern.</aside>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn2" data-bf-page="9" data-bf-cat="footnote" data-bf-id="p9-5"><sup>2</sup> Eine Note, auf die nichts zeigt.</aside>
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
  models: string[] = ['qwen3:32b'],
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
