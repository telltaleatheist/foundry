/**
 * vlm/epub — the book, assembled from what the model read.
 *
 * A SECOND EMITTER, and deliberately not `src/export/epub.ts`. That one takes
 * labelled BLOCKS with geometry, a paragraph grouping, a calibration verdict and
 * a hyphen attestation, and every one of those is a product of the Tesseract
 * pipeline measuring a page. This mode has none of them: a vision model returns
 * a page already reflowed, already marked up, with no coordinates and no lines.
 * Bending one input shape into the other would mean inventing the measurements —
 * a fabricated calibration is a lie the exporter would then reason from — so the
 * two emitters stay separate and the container writer (`src/export/zip.ts`) is
 * the only thing they share.
 *
 * WHERE THE CHAPTERS COME FROM: the highest heading level the book actually
 * uses. A book whose top level is `#` splits on `#` and keeps `##` inside the
 * chapter; a book that only ever emits `##` splits on `##`. Fixing on `h1` would
 * put a whole book in one file whenever the model preferred `##`, and splitting
 * on every heading would make a chapter out of every subsection. Anything before
 * the first heading becomes a leading section, because front matter has to go
 * somewhere.
 *
 * Provenance, the same promise `src/export/epub.ts` makes: every element carries
 * `data-bf-page`, the page of the PDF it was read from. The mapping from a page
 * to a paragraph is otherwise unrecoverable once the pages are joined, and it is
 * the first thing anyone checking this mode's output wants.
 */
import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import type { VlmBlock } from './dialect.js';
import type { DotsPageKind } from './dots.js';

export class VlmEpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmEpubError';
  }
}

export interface VlmEpubMetadata {
  title: string;
  /** Absent when the PDF does not name one. Never invented. */
  author?: string;
  /** BCP-47. Declared, not detected — see the `--language` option. */
  language: string;
  identifier: string;
}

/** One page's worth of blocks, in reading order. */
export interface VlmPageBlocks {
  number: number;
  blocks: readonly VlmBlock[];
}

export interface VlmChapter {
  id: string;
  href: string;
  label: string;
  /** For the report: how many blocks, and which pages it spans. */
  blocks: number;
  firstPage: number;
  lastPage: number;
  /**
   * What this section IS, when its opening page said so loudly enough
   * (`classifyPage` in `dots.ts`). Absent is the ordinary answer, and the only
   * one the prose emitter ever gives.
   */
  kind?: DotsPageKind;
}

/**
 * One entry in the nav document, and its children.
 *
 * A flat list of chapters is what most books are and what every book was until
 * a book with PARTS in it arrived. EPUB3's nav is an `<ol>` and nests by
 * carrying another `<ol>` inside an `<li>`, which is the shape a publisher's
 * contents page has always had; a reader that ignores the nesting still gets
 * every entry, in order.
 */
export interface VlmNavItem {
  href: string;
  label: string;
  children?: readonly VlmNavItem[];
}

export interface VlmEpubResult {
  bytes: Uint8Array;
  chapters: VlmChapter[];
  /**
   * How long the two halves of assembly took.
   *
   * Measured here because this is where they happen and the command prints a
   * phase breakdown — a mode whose cost is minutes of GPU has to be able to say
   * which minutes. Nothing in the book depends on these numbers.
   */
  xhtmlSeconds: number;
  zipSeconds: number;
}

export const OPF_DIR = 'EPUB';

/**
 * A fixed timestamp, so the same pages produce the same bytes.
 *
 * Same reasoning as `src/export/zip.ts`'s fixed DOS date: an EPUB that differs
 * from the last one only in a clock reading makes "did anything change" a
 * question nobody can answer.
 */
const FIXED_MODIFIED = '1980-01-01T00:00:00Z';

const STYLESHEET = `/* Foundry — vlm-convert. No per-book font decisions, ever. */
html { font-size: 100%; }
body { margin: 0 5%; line-height: 1.5; }
h1, h2, h3 { line-height: 1.2; text-align: left; }
p { margin: 0; text-indent: 1.2em; }
p:first-child, h1 + p, h2 + p, h3 + p { text-indent: 0; }
p.image { font-style: italic; text-indent: 0; margin: 1em 0; }
sup { font-size: 0.75em; line-height: 0; vertical-align: super; }
table { border-collapse: collapse; margin: 1em 0; }
td, th { border: 1px solid currentColor; padding: 0.2em 0.4em; }
`;

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const XHTML_HEAD = (title: string, lang: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
  + ` xml:lang="${esc(lang)}" lang="${esc(lang)}">\n`
  + `<head>\n  <meta charset="utf-8"/>\n  <title>${esc(title)}</title>\n`
  + `  <link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n<body>\n`;

export const XHTML_TAIL = '</body>\n</html>\n';

/**
 * One XHTML document of the book, already rendered.
 *
 * The two emitters in this directory build their documents from different
 * inputs and neither can build the other's, but an EPUB CONTAINER is an EPUB
 * container: the same `mimetype`-first rule, the same nav document, the same
 * package. `packageVlmEpub` below is that shared half, and it is the only place
 * either of them writes one.
 */
export interface VlmDocument {
  /** Manifest id, unique in the package. */
  id: string;
  /** Href relative to `OPF_DIR`, e.g. `text/c0001.xhtml`. */
  href: string;
  /** The TOC label. */
  label: string;
  xhtml: string;
}

/** A non-document file the book carries — a cropped picture, so far. */
export interface VlmResource {
  id: string;
  href: string;
  mediaType: string;
  data: Uint8Array;
}

/**
 * Container, nav, package, zip — everything about an EPUB that is not the
 * book's own words.
 */
export function packageVlmEpub(
  metadata: VlmEpubMetadata,
  documents: readonly VlmDocument[],
  resources: readonly VlmResource[],
  stylesheet: string,
  /**
   * The nav, when the book has a shape the documents' order does not carry.
   *
   * Absent means one entry per document in spine order, which is what a book
   * without parts is and what every caller wanted until one of them could tell
   * a part from a chapter. A caller that passes a flat tree gets byte-identical
   * output to one that passes nothing.
   */
  nav?: readonly VlmNavItem[],
): { bytes: Uint8Array; zipSeconds: number } {
  if (documents.length === 0) {
    throw new VlmEpubError('no text survived the pages — there is no book to write');
  }
  const entries: ZipEntry[] = [];

  // FIRST, stored, no extra field — the OCF spec lets a reader identify an EPUB
  // by reading byte offset 30 without parsing anything. `writeZip` never
  // reorders and never compresses, so ordering it first here is the whole job.
  entries.push(zipText('mimetype', 'application/epub+zip'));

  entries.push(zipText('META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
    + `  <rootfiles>\n`
    + `    <rootfile full-path="${OPF_DIR}/package.opf" media-type="application/oebps-package+xml"/>\n`
    + `  </rootfiles>\n</container>\n`));

  entries.push(zipText(`${OPF_DIR}/style.css`, stylesheet));

  for (const document of documents) {
    entries.push(zipText(`${OPF_DIR}/${document.href}`, document.xhtml));
  }
  for (const resource of resources) {
    entries.push({ path: `${OPF_DIR}/${resource.href}`, data: resource.data });
  }

  const navItems = renderNav(nav ?? documents.map((d) => ({ href: d.href, label: d.label })), 6);
  entries.push(zipText(`${OPF_DIR}/nav.xhtml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
    + ` xml:lang="${esc(metadata.language)}" lang="${esc(metadata.language)}">\n`
    + `<head>\n  <meta charset="utf-8"/>\n  <title>${esc(metadata.title)}</title>\n</head>\n<body>\n`
    + `  <nav epub:type="toc" id="toc">\n    <h1>Contents</h1>\n    <ol>\n${navItems}\n    </ol>\n  </nav>\n`
    + `  <nav epub:type="landmarks" id="landmarks" hidden="">\n    <h1>Landmarks</h1>\n    <ol>\n`
    + `      <li><a epub:type="bodymatter" href="${esc(documents[0].href)}">Beginning</a></li>\n`
    + `    </ol>\n  </nav>\n</body>\n</html>\n`));

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="style" href="style.css" media-type="text/css"/>`,
    ...documents.map((d) =>
      `    <item id="${d.id}" href="${esc(d.href)}" media-type="application/xhtml+xml"/>`),
    ...resources.map((r) =>
      `    <item id="${r.id}" href="${esc(r.href)}" media-type="${esc(r.mediaType)}"/>`),
  ].join('\n');
  const spine = documents.map((d) => `    <itemref idref="${d.id}"/>`).join('\n');

  entries.push(zipText(`${OPF_DIR}/package.opf`,
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"`
    + ` xml:lang="${esc(metadata.language)}">\n`
    + `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n`
    + `    <dc:identifier id="pub-id">${esc(metadata.identifier)}</dc:identifier>\n`
    + `    <dc:title>${esc(metadata.title)}</dc:title>\n`
    + `    <dc:language>${esc(metadata.language)}</dc:language>\n`
    + (metadata.author ? `    <dc:creator>${esc(metadata.author)}</dc:creator>\n` : '')
    + `    <meta property="dcterms:modified">${FIXED_MODIFIED}</meta>\n`
    + `  </metadata>\n  <manifest>\n${manifest}\n  </manifest>\n`
    + `  <spine>\n${spine}\n  </spine>\n</package>\n`));

  const zipStarted = Date.now();
  const bytes = writeZip(entries);
  return { bytes, zipSeconds: (Date.now() - zipStarted) / 1000 };
}

/**
 * The nav's `<li>`s, nested where the tree is.
 *
 * A childless item renders exactly as the flat list always did, so a book with
 * no parts in it produces the same bytes it did before nesting existed.
 */
function renderNav(items: readonly VlmNavItem[], indent: number): string {
  const pad = ' '.repeat(indent);
  return items.map((item) => {
    const anchor = `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
    if (item.children === undefined || item.children.length === 0) {
      return `${pad}<li>${anchor}</li>`;
    }
    return `${pad}<li>${anchor}\n${pad}  <ol>\n`
      + `${renderNav(item.children, indent + 4)}\n${pad}  </ol>\n${pad}</li>`;
  }).join('\n');
}

/** A block with the page it was read from, which is what gets rendered. */
interface PlacedBlock {
  page: number;
  block: VlmBlock;
}

function render(placed: PlacedBlock): string {
  const { page, block } = placed;
  const p = ` data-bf-page="${page}"`;
  switch (block.kind) {
    case 'heading': {
      // Levels below h3 are rendered as h3: the dialects emit up to six, and a
      // book made of paragraphs has no use for a fourth rank of heading. The
      // LEVEL still decided where the chapters split, which is the part that
      // matters; this is only how it looks.
      const tag = block.level <= 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
      return `<${tag}${p}>${block.xhtml}</${tag}>`;
    }
    case 'paragraph':
      return `<p${p}>${block.xhtml}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.filter((i) => i.trim().length > 0);
      if (items.length === 0) return '';
      return `<${tag}${p}>\n${items.map((i) => `  <li>${i}</li>`).join('\n')}\n</${tag}>`;
    }
    case 'html':
      // Already verified well-formed by the dialect parser. It carries no
      // `data-bf-page`: the fragment is the model's own markup and this
      // emitter does not reach inside it to add an attribute.
      return block.xhtml;
  }
}

/**
 * The heading level the book splits on: the highest one it actually uses.
 * `null` when the model found no headings at all, which is an ordinary outcome
 * for an extract or a single article.
 */
function splitLevel(pages: readonly VlmPageBlocks[]): number | null {
  let best: number | null = null;
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'heading') continue;
      if (best === null || block.level < best) best = block.level;
    }
  }
  return best;
}

export function buildVlmEpub(
  metadata: VlmEpubMetadata,
  pages: readonly VlmPageBlocks[],
): VlmEpubResult {
  const started = Date.now();
  const placed: PlacedBlock[] = pages.flatMap((p) => p.blocks.map((block) => ({ page: p.number, block })));
  if (placed.length === 0) {
    throw new VlmEpubError('no text survived the pages — there is no book to write');
  }

  const level = splitLevel(pages);
  const sections: { label: string; blocks: PlacedBlock[] }[] = [];
  for (const item of placed) {
    const opens = level !== null && item.block.kind === 'heading' && item.block.level === level;
    if (opens || sections.length === 0) {
      const label = opens && item.block.kind === 'heading' && item.block.text.length > 0
        ? item.block.text
        // A chapter whose opening heading is empty, and the leading section of a
        // book that starts mid-prose, both need a name for the TOC. Numbered
        // rather than guessed: nothing here knows what the section is called.
        : `Section ${sections.length + 1}`;
      sections.push({ label, blocks: [] });
    }
    sections[sections.length - 1].blocks.push(item);
  }

  const chapters: VlmChapter[] = sections.map((section, index) => {
    const n = String(index + 1).padStart(4, '0');
    const pageNumbers = section.blocks.map((b) => b.page);
    return {
      id: `c${n}`,
      href: `text/c${n}.xhtml`,
      label: section.label,
      blocks: section.blocks.length,
      firstPage: Math.min(...pageNumbers),
      lastPage: Math.max(...pageNumbers),
    };
  });

  const documents: VlmDocument[] = sections.map((section, index) => {
    const chapter = chapters[index];
    const body = section.blocks.map(render).filter((html) => html.length > 0);
    return {
      id: chapter.id,
      href: chapter.href,
      label: chapter.label,
      xhtml: XHTML_HEAD(chapter.label, metadata.language) + body.join('\n') + '\n' + XHTML_TAIL,
    };
  });

  const xhtmlSeconds = (Date.now() - started) / 1000;
  const packaged = packageVlmEpub(metadata, documents, [], STYLESHEET);
  return { bytes: packaged.bytes, chapters, xhtmlSeconds, zipSeconds: packaged.zipSeconds };
}
