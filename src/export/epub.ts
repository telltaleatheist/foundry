/**
 * epub — the category-driven EPUB3 emitter.
 *
 * The last consumer of the run directory (PIPELINE.md). It takes labelled
 * blocks plus the paragraph grouping and produces a readable book: title
 * sections, chapter markers where `chapter` blocks were found, headings, and
 * flowing paragraphs. The owner's product definition is "a user feeds in a PDF,
 * bad scan or decent one, and it reflows into a readable EPUB", and everything
 * here follows from that sentence.
 *
 * ## Category → element
 *
 * | category           | emitted as                                        |
 * |--------------------|---------------------------------------------------|
 * | `title`            | opens a section, `<h1 class="title">`             |
 * | `chapter`          | opens a section, `<h1>`, and a TOC entry          |
 * | `heading`          | `<h2>` in place                                   |
 * | `subheading`       | `<h3>` in place                                   |
 * | `body`             | `<p>`                                             |
 * | `quote`            | `<blockquote><p>`                                 |
 * | `caption`          | `<p class="caption">` (figcaption-style)          |
 * | `list`             | `<ul>`, one `<li>` per line                       |
 * | `image`            | `<p class="image-text">`                          |
 * | `footnote`         | collected into an end-of-section `<section>`      |
 * | `header`/`footer`/`discard` | never emitted (see exclude.ts)           |
 *
 * Three of those deserve their reasoning written down, because PIPELINE.md
 * does not settle them:
 *
 *  - **`list` gets one `<li>` per line.** Every other category joins its lines
 *    into prose, and doing that to a list produces one run-on sentence out of
 *    twelve entries. A list's line breaks are the author's, not the page's,
 *    which is exactly the case where the line-join rule does not apply.
 *  - **`image` text is emitted, marked.** PIPELINE.md names the never-emitted
 *    set exhaustively — furniture and `discard` — so everything else is content
 *    unless excluded. An `image` block is text Tesseract read off a picture, so
 *    it is often junk, but dropping it silently would be a decision the user
 *    cannot see or undo. Emitted with a class, and `--exclude image` removes it.
 *  - **Footnotes are collected per SECTION, never linked.** PIPELINE.md is
 *    explicit that markers are not linked to bodies — foundry-footnotes removes
 *    the markers themselves — so there is nothing to link to and inventing
 *    anchors would produce dead links in every reader.
 *
 * ## The title page is a spine item, not a chapter
 *
 * A real book's title page is a page, and a real EPUB's is a document of its
 * own, ahead of the first chapter and listed in the EPUB3 **landmarks** nav
 * rather than in the reading TOC — a title page listed as a chapter is a
 * chapter the reader did not write.
 *
 * Which one a `title` block is has to be DERIVED, because nothing in the run
 * directory declares it: `blocks/blocks.json` carries a category per block and
 * no page-level fact at all, so a title page and a `title` opening a chapter
 * arrive as the same label. The exporter therefore asks the question the blocks
 * stage's page gate asks (`display-run-merge.ts`): is there a PAGE here that is
 * nothing but title? Concretely — the leading run of `title` groups, when the
 * pages those groups sit on carry no other surviving content. Where that does
 * not hold nothing changes, and the title opens an ordinary section exactly as
 * it always did.
 *
 * ## One stylesheet, shipped
 *
 * No font matching, ever (PIPELINE.md). The CSS below is the whole typographic
 * policy: the reader's font, a readable measure, and paragraph indents that
 * follow the book's own calibrated convention. That last point is the only
 * place calibration touches presentation — an indent-style book gets indented
 * paragraphs, a block-style book gets spaced ones, so the EPUB reads the way
 * the source did.
 */
import type { Block, CalibrationVerdict, ScanLine } from '../pipeline/artifacts.js';
import type { BlocksCategory } from '../blocks/encoder.js';
import type { GroupingReport, ParagraphGroup } from '../paragraphs/grouping.js';
import { groupParagraphs } from '../paragraphs/grouping.js';
import { computeBlockGeometry } from '../paragraphs/geometry.js';
import type { HyphenAttestation } from '../paragraphs/hyphen.js';
import { applyExclusions, type ExclusionRequest, type ExclusionResult } from './exclude.js';
import { joinLines } from './linejoin.js';
import { writeZip, zipText, type ZipEntry } from './zip.js';

// ── inputs ──────────────────────────────────────────────────────────────────

export interface EpubMetadata {
  title: string;
  /** BCP-47, e.g. 'en'. */
  language: string;
  /** The unique identifier. A URN, a UUID, anything stable for this book. */
  identifier: string;
  author?: string;
  /**
   * dcterms:modified. Fixed by default, so the same input produces a
   * byte-identical EPUB — see zip.ts on reproducibility.
   */
  modified?: string;
}

export interface BuildEpubInput {
  /** Labelled blocks in reading order, straight from `blocks/blocks.json`. */
  readonly blocks: readonly Block[];
  /**
   * Every line of the book, with its FINAL text — needed to re-derive the
   * prev-relative geometry facts after exclusion. See `buildEpub`.
   */
  readonly lines: readonly ScanLine[];
  /**
   * The text of each block as an ordered list of units — normally its lines,
   * so the line-join rules can see the wrap hyphens. A block the footnotes
   * stage rewrote arrives as a single already-joined unit.
   */
  readonly blockText: ReadonlyMap<string, readonly string[]>;
  readonly calibration: CalibrationVerdict;
  readonly metadata: EpubMetadata;
  /** The book's own vocabulary, for healing wrap hyphens. */
  readonly attestation: HyphenAttestation;
  readonly exclude?: ExclusionRequest;
}

/**
 * What a spine item IS, which decides both its markup and whether it appears in
 * the reading TOC. A `titlepage` is listed in landmarks instead.
 */
export type SectionRole = 'titlepage' | 'text';

export interface EpubSection {
  id: string;
  role: SectionRole;
  /** The TOC label, and the document's own `<title>`. */
  label: string;
  /** Href relative to the package document. */
  href: string;
  /** Paragraph groups rendered in the body of this section. */
  groupIds: string[];
  /** Paragraph groups rendered in its footnote section. */
  footnoteGroupIds: string[];
}

export interface BuildEpubResult {
  zip: Uint8Array;
  exclusions: ExclusionResult['record'];
  grouping: GroupingReport;
  sections: EpubSection[];
  /** Wrap-hyphenated words rejoined on the book's own evidence. */
  healedHyphens: number;
  /** Wrap hyphens kept because the join was unproven. */
  keptHyphens: number;
  /** Every file in the container, in order — the first is always `mimetype`. */
  entryPaths: string[];
}

export class EpubError extends Error {
  constructor(message: string) {
    super(`epub: ${message}`);
    this.name = 'EpubError';
  }
}

// ── XML helpers ─────────────────────────────────────────────────────────────

/**
 * Escape for XML text and attribute content in one function.
 *
 * All five predefined entities, always, including the two that are only
 * strictly required inside attributes. XHTML is XML: an unescaped `&` from a
 * scan — and OCR produces them — is not a rendering quirk, it is a document
 * that will not parse, and the reader shows nothing at all.
 */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip characters XML 1.0 forbids outright.
 *
 * Control characters below 0x20 (other than tab, newline, carriage return) can
 * appear in OCR output and CANNOT be represented in XML at all — not escaped,
 * not as a numeric reference. There is no way to keep them, so they go, and
 * that is a lossless choice for text nobody can render.
 */
function stripIllegalXml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

const clean = (text: string): string => xml(stripIllegalXml(text));

// ── the stylesheet ──────────────────────────────────────────────────────────

const STYLESHEET_INDENT = `/* Foundry — the one stylesheet. No per-book font decisions, ever. */
html { font-size: 100%; }
body {
  margin: 0 5%;
  line-height: 1.5;
  text-align: left;
  hyphens: auto;
}
h1, h2, h3 { line-height: 1.2; text-align: left; page-break-after: avoid; }
h1 { font-size: 1.6em; margin: 2em 0 1em; }
h1.title { font-size: 2em; margin: 3em 0 1em; text-align: center; }
h2 { font-size: 1.3em; margin: 1.8em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1.4em 0 0.4em; }
p { margin: 0; text-indent: 1.5em; }
/* The first paragraph after a heading or a break opens flush — an indent marks
   continuation from what came before, and there is nothing before it. */
h1 + p, h2 + p, h3 + p, blockquote + p, ul + p, p.caption + p { text-indent: 0; }
blockquote { margin: 1em 2em; }
blockquote p { text-indent: 0; }
p.caption { margin: 0.6em 0; font-size: 0.9em; font-style: italic; text-indent: 0; }
p.image-text { margin: 0.6em 0; font-size: 0.9em; color: #555; text-indent: 0; }
ul { margin: 1em 0; padding-left: 1.5em; }
li { margin: 0.2em 0; }
section.footnotes { margin-top: 2.5em; border-top: 1px solid currentColor; padding-top: 1em; font-size: 0.9em; }
section.footnotes h2 { font-size: 1em; }
section.footnotes p { text-indent: 0; margin: 0.4em 0; }
/* A title page is a plate, not prose: everything centred, nothing indented,
   and no measure to hold to. */
section.titlepage { margin-top: 15%; text-align: center; }
section.titlepage h1.title { margin: 0 0 1em; }
section.titlepage p, section.titlepage p.caption { text-align: center; text-indent: 0; }
`;

/**
 * The block-style variant: paragraphs are separated by space rather than opened
 * with an indent. Chosen by the book's calibrated convention so the EPUB reads
 * the way the source did — the one place calibration touches presentation.
 *
 * A degraded book ('none') gets this one too: with few breaks, spacing is the
 * more forgiving of the two, and indenting a page-long paragraph indents it
 * exactly once for no benefit.
 */
const STYLESHEET_BLOCK = STYLESHEET_INDENT
  .replace('p { margin: 0; text-indent: 1.5em; }', 'p { margin: 0 0 0.8em; text-indent: 0; }');

// ── rendering ───────────────────────────────────────────────────────────────

/** Categories that open a new spine item. */
const SECTION_OPENERS: ReadonlySet<BlocksCategory> = new Set<BlocksCategory>(['title', 'chapter']);

const NO_TITLE_PAGE: ReadonlySet<string> = new Set<string>();

/**
 * The groups that make up the book's title page, or nothing.
 *
 * Derived, because nothing on disk declares one: `blocks/blocks.json` carries a
 * category per block and no page-level fact, so a `title` block opening a
 * chapter and a whole title page are the same label at the same altitude. The
 * question that separates them is the one the blocks stage's page gate asks —
 * is there a PAGE here that is nothing but title? — and it is answerable from
 * the artifact, because every block names its page.
 *
 * Three conditions, and all three are the definition rather than guards:
 *
 *  - The run is LEADING. A title page precedes the book; a `title` that turns
 *    up after the third chapter is a display heading, whatever it says.
 *  - The pages that run occupies carry NO OTHER surviving group. This is the
 *    whole discrimination: a chapter-opening title shares its page with the
 *    prose underneath it, and a title page does not share its page with
 *    anything. Measured over what SURVIVED the exclusions, deliberately —
 *    excluding a category is the user saying it is not in the book.
 *  - Something follows it. A run of title groups that is the entire book is not
 *    a page before the book; there is no book for it to be before, and carving
 *    it out would leave a reading TOC with nothing in it.
 */
function findTitlePage(
  groups: readonly ParagraphGroup[],
  blocks: readonly Block[],
): ReadonlySet<string> {
  const lead: ParagraphGroup[] = [];
  for (const group of groups) {
    if (group.category !== 'title') break;
    lead.push(group);
  }
  if (lead.length === 0 || lead.length === groups.length) return NO_TITLE_PAGE;

  // A group's own `page` is where it OPENS, and a group can span a page turn,
  // so the pages come from the blocks themselves.
  const pageOf = new Map(blocks.map(b => [b.id, b.page] as const));
  const pagesOf = (group: ParagraphGroup): number[] =>
    group.blockIds.map(id => {
      const page = pageOf.get(id);
      if (page === undefined) {
        throw new EpubError(`group ${group.id} names block ${id}, which is not among the blocks being exported`);
      }
      return page;
    });

  const ids = new Set(lead.map(g => g.id));
  const pages = new Set(lead.flatMap(pagesOf));
  for (const group of groups) {
    if (ids.has(group.id)) continue;
    if (pagesOf(group).some(page => pages.has(page))) return NO_TITLE_PAGE;
  }
  return ids;
}

interface RenderedGroup {
  group: ParagraphGroup;
  text: string;
  /** The lines, kept for `list`, which does not join them into prose. */
  lines: string[];
}

function renderGroup(g: RenderedGroup): string {
  const { group, text, lines } = g;
  if (text.length === 0 && lines.length === 0) return '';
  switch (group.category) {
    case 'title': return `<h1 class="title">${clean(text)}</h1>`;
    case 'chapter': return `<h1>${clean(text)}</h1>`;
    case 'heading': return `<h2>${clean(text)}</h2>`;
    case 'subheading': return `<h3>${clean(text)}</h3>`;
    case 'quote': return `<blockquote><p>${clean(text)}</p></blockquote>`;
    case 'caption': return `<p class="caption">${clean(text)}</p>`;
    case 'image': return `<p class="image-text">${clean(text)}</p>`;
    case 'list': {
      const items = lines.map(l => l.trim()).filter(l => l.length > 0);
      if (items.length === 0) return '';
      return `<ul>\n${items.map(l => `  <li>${clean(l)}</li>`).join('\n')}\n</ul>`;
    }
    case 'footnote': return `<p class="footnote">${clean(text)}</p>`;
    case 'body': return `<p>${clean(text)}</p>`;
    // Every content category is above, and the three never-emitted ones were
    // filtered by applyExclusions. Reaching here means the taxonomy grew and
    // this table did not, which is a decision to make deliberately rather than
    // a paragraph to emit by default.
    default: throw new EpubError(
      `category "${group.category}" reached the renderer with no rule for it —`
      + ' add it to the category table in epub.ts or to the never-emitted set',
    );
  }
}

const XHTML_HEAD = (title: string, lang: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
  + ` xml:lang="${clean(lang)}" lang="${clean(lang)}">\n`
  + `<head>\n  <meta charset="utf-8"/>\n  <title>${clean(title)}</title>\n`
  + `  <link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n<body>\n`;

const XHTML_TAIL = '</body>\n</html>\n';

// ── the build ───────────────────────────────────────────────────────────────

const OPF_DIR = 'EPUB';
const FIXED_MODIFIED = '1980-01-01T00:00:00Z';

/**
 * Build the EPUB.
 *
 * Pure: no filesystem, no clock. It returns the container's bytes and the
 * record of what was excluded, and the stage that calls it does the writing —
 * which is what makes the whole thing fixture-testable.
 */
export function buildEpub(input: BuildEpubInput): BuildEpubResult {
  const { record, kept } = applyExclusions(input.blocks, input.exclude);

  if (kept.length === 0) {
    throw new EpubError(
      `no blocks survived the exclusions — ${record.totalBlocks} blocks in,`
      + ` ${Object.values(record.droppedByCategory).reduce((a, b) => a + b, 0)} dropped by category,`
      + ` ${record.droppedById} by id,`
      + ` ${Object.values(record.droppedByNeverEmitted).reduce((a, b) => a + b, 0)} never emitted.`
      + ' There is no book to write.',
    );
  }

  // RE-DERIVE the prev-relative geometry over the blocks that survived.
  //
  // Three of the four §9d facts describe a block's JUNCTION WITH ITS
  // PREDECESSOR, so they are only meaningful against the sequence the grouper
  // actually walks — and that sequence is not the one the blocks stage measured.
  // Two things stand between them:
  //
  //  - **Page furniture, always.** A running head and a folio sit between the
  //    last body block of one page and the first of the next, in reading order.
  //    Measured against them, `prevEndsWrapHyphen` on the block after a page
  //    turn asks whether a running head ends mid-word, which it never does — so
  //    the single strongest continuation signal there is would be lost at
  //    exactly the junction that needs it most, the one where a paragraph
  //    crosses a page.
  //  - **The user's exclusions.** Dropping `--exclude footnote` can make two
  //    body blocks adjacent that were not adjacent before.
  //
  // `firstLineIndent` is self-relative and unaffected, but it is recomputed
  // with the rest rather than being spliced, because one function producing all
  // four facts is the thing that keeps them consistent. The result is still
  // explainable from the run directory alone: the lines, the calibration frame
  // and the exclusions are all there, and this is a deterministic function of
  // them.
  const regrouped = ((): Block[] => {
    const geometry = computeBlockGeometry(kept, input.lines, input.calibration);
    return kept.map(b => ({ ...b, geometry: geometry.get(b.id)! }));
  })();

  const { groups, report } = groupParagraphs(regrouped, input.calibration);

  // Join each group's text once. A group's units are all its blocks' units
  // concatenated, so a wrap hyphen spanning a block junction is healed exactly
  // like one spanning a line break — the junction is why the blocks are one
  // paragraph in the first place.
  let healedHyphens = 0;
  let keptHyphens = 0;
  const rendered = new Map<string, RenderedGroup>();
  for (const group of groups) {
    const lines: string[] = [];
    for (const id of group.blockIds) {
      const units = input.blockText.get(id);
      if (units === undefined) {
        throw new EpubError(`block ${id} has no text — every block reaching the exporter must carry its text`);
      }
      lines.push(...units);
    }
    const joined = joinLines(lines, input.attestation);
    healedHyphens += joined.healed;
    keptHyphens += joined.keptHyphens;
    rendered.set(group.id, { group, text: joined.text, lines });
  }

  // Split the spine. A `chapter` or `title` group opens a section; anything
  // before the first one goes into a leading section of its own, because a book
  // whose front matter preceded its first chapter would otherwise have nowhere
  // to put it.
  //
  // CONSECUTIVE same-category openers on the SAME PAGE are one display heading,
  // not several sections. Block formation splits a multi-line title into one
  // block per line (the gap splitter cannot see that "Nationalism, Nazism, and"
  // / "the Churches:" / "The Early Period" is one heading), and opening a
  // section per fragment gave the Barnett book seven garbage "chapters" from
  // its title page. They extend the open section and its label instead. The
  // page bound is deliberate: a part divider ("OMENS") on its own page ahead of
  // a chapter opening keeps its own TOC entry.
  const titlePage = findTitlePage(groups, regrouped);

  const sections: EpubSection[] = [];
  const openSection = (label: string, role: SectionRole): EpubSection => {
    const n = sections.length + 1;
    const s: EpubSection = {
      id: `s${String(n).padStart(4, '0')}`,
      role,
      label,
      href: `text/s${String(n).padStart(4, '0')}.xhtml`,
      groupIds: [],
      footnoteGroupIds: [],
    };
    sections.push(s);
    return s;
  };

  let current: EpubSection | null = null;
  let openerRun: { category: BlocksCategory; page: number } | null = null;
  for (const group of groups) {
    if (titlePage.has(group.id)) {
      // Every title group of the title page goes into ONE section, in reading
      // order, and nothing else may join it — the page is the unit.
      const label = rendered.get(group.id)!.text.trim();
      if (current !== null && current.role === 'titlepage') {
        if (label.length > 0) current.label = `${current.label} ${label}`.trim();
      } else {
        current = openSection(label.length > 0 ? label : 'Title page', 'titlepage');
      }
      openerRun = null;
      current.groupIds.push(group.id);
      continue;
    }
    if (SECTION_OPENERS.has(group.category)) {
      const label = rendered.get(group.id)!.text.trim();
      if (current !== null && current.role === 'text' && openerRun !== null
        && openerRun.category === group.category && openerRun.page === group.page) {
        if (label.length > 0) current.label = `${current.label} ${label}`.trim();
      } else {
        current = openSection(label.length > 0 ? label : `Section ${sections.length + 1}`, 'text');
      }
      openerRun = { category: group.category, page: group.page };
    } else {
      // A title page is closed by whatever follows it: the front matter that
      // comes after one is not part of it.
      if (current === null || current.role === 'titlepage') current = openSection('Front matter', 'text');
      openerRun = null;
    }
    if (group.category === 'footnote') current.footnoteGroupIds.push(group.id);
    else current.groupIds.push(group.id);
  }

  if (sections.length === 0) throw new EpubError('no sections were produced from surviving blocks');

  // ── the container ─────────────────────────────────────────────────────────

  const meta = input.metadata;
  const modified = meta.modified ?? FIXED_MODIFIED;
  const entries: ZipEntry[] = [];

  // FIRST, stored, no extra field. The OCF spec lets a reader identify an EPUB
  // by reading byte offset 30 without parsing anything.
  entries.push(zipText('mimetype', 'application/epub+zip'));

  entries.push(zipText('META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
    + `  <rootfiles>\n`
    + `    <rootfile full-path="${OPF_DIR}/package.opf" media-type="application/oebps-package+xml"/>\n`
    + `  </rootfiles>\n</container>\n`));

  entries.push(zipText(`${OPF_DIR}/style.css`,
    input.calibration.convention === 'indent' ? STYLESHEET_INDENT : STYLESHEET_BLOCK));

  for (const s of sections) {
    const body: string[] = [];
    for (const gid of s.groupIds) {
      const html = renderGroup(rendered.get(gid)!);
      if (html.length > 0) body.push(html);
    }
    if (s.role === 'titlepage' && body.length > 0) {
      body.splice(0, body.length,
        `<section epub:type="titlepage" class="titlepage">\n${body.join('\n')}\n</section>`);
    }
    if (s.footnoteGroupIds.length > 0) {
      const notes = s.footnoteGroupIds
        .map(gid => renderGroup(rendered.get(gid)!))
        .filter(h => h.length > 0);
      if (notes.length > 0) {
        // epub:type="footnotes" with no backlinks: PIPELINE.md is explicit that
        // markers are not linked to bodies, so there is nothing to point at.
        body.push(
          `<section epub:type="footnotes" class="footnotes" role="doc-endnotes">\n`
          + `<h2>Notes</h2>\n${notes.join('\n')}\n</section>`,
        );
      }
    }
    entries.push(zipText(`${OPF_DIR}/${s.href}`,
      XHTML_HEAD(s.label, meta.language) + body.join('\n') + '\n' + XHTML_TAIL));
  }

  // The reading TOC is the READING order: the title page is in the spine but
  // not in it. Every real EPUB does this, and the reason is that a TOC entry
  // called "Title page" is an entry the author never wrote — it is declared in
  // `landmarks` below, which is what a reading system's "go to" menu is built
  // from.
  const navItems = sections
    .filter(s => s.role === 'text')
    .map(s => `      <li><a href="${clean(s.href)}">${clean(s.label)}</a></li>`)
    .join('\n');
  const landmark = (type: string, s: EpubSection, text: string): string =>
    `      <li><a epub:type="${type}" href="${clean(s.href)}">${text}</a></li>`;
  const titleSection = sections.find(s => s.role === 'titlepage');
  const bodySection = sections.find(s => s.role === 'text');
  const landmarks = [
    ...(titleSection ? [landmark('titlepage', titleSection, 'Title page')] : []),
    // Always present: `sections` is non-empty and only a `text` section can
    // carry the book, so there is always somewhere for "start reading" to go.
    ...(bodySection ? [landmark('bodymatter', bodySection, 'Beginning')] : []),
  ].join('\n');
  entries.push(zipText(`${OPF_DIR}/nav.xhtml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
    + ` xml:lang="${clean(meta.language)}" lang="${clean(meta.language)}">\n`
    + `<head>\n  <meta charset="utf-8"/>\n  <title>${clean(meta.title)}</title>\n</head>\n<body>\n`
    + `  <nav epub:type="toc" id="toc">\n    <h1>Contents</h1>\n    <ol>\n${navItems}\n    </ol>\n  </nav>\n`
    + `  <nav epub:type="landmarks" id="landmarks" hidden="">\n    <h1>Landmarks</h1>\n`
    + `    <ol>\n${landmarks}\n    </ol>\n  </nav>\n`
    + `</body>\n</html>\n`));

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="style" href="style.css" media-type="text/css"/>`,
    ...sections.map(s =>
      `    <item id="${s.id}" href="${clean(s.href)}" media-type="application/xhtml+xml"/>`),
  ].join('\n');
  const spine = sections.map(s => `    <itemref idref="${s.id}"/>`).join('\n');

  entries.push(zipText(`${OPF_DIR}/package.opf`,
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"`
    + ` xml:lang="${clean(meta.language)}">\n`
    + `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n`
    + `    <dc:identifier id="pub-id">${clean(meta.identifier)}</dc:identifier>\n`
    + `    <dc:title>${clean(meta.title)}</dc:title>\n`
    + `    <dc:language>${clean(meta.language)}</dc:language>\n`
    + (meta.author ? `    <dc:creator>${clean(meta.author)}</dc:creator>\n` : '')
    + `    <meta property="dcterms:modified">${clean(modified)}</meta>\n`
    + `  </metadata>\n  <manifest>\n${manifest}\n  </manifest>\n`
    + `  <spine>\n${spine}\n  </spine>\n</package>\n`));

  return {
    zip: writeZip(entries),
    exclusions: record,
    grouping: report,
    sections,
    healedHyphens,
    keptHyphens,
    entryPaths: entries.map(e => e.path),
  };
}
