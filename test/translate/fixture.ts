/**
 * A tiny foundry EPUB, and a translator that is not a language model.
 *
 * The book is built with the same writer the real emitter uses
 * (`src/export/zip.ts`) and carries one of every shape the translator has to
 * cope with: a chapter opening with a page-break span inside the heading,
 * emphasis, a footnote reference anchored to a note at the end of the file, a
 * list whose `<ul>` and `<li>` are BOTH stamped, a quote whose `<blockquote>`
 * and inner `<p>` are both stamped, and one each of the three categories that
 * must come out untouched.
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
<section class="footnotes" epub:type="footnotes">
<hr/>
<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="9" data-bf-cat="footnote"><sup>1</sup> Siehe dazu das Werk von gestern.</aside>
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
    zipText(OPF_PATH, OPF),
  ]);
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
