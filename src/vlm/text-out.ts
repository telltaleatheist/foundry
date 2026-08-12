/**
 * vlm/text-out — the same book, with the markup taken back off.
 *
 * A THIRD EMITTER, and it never reads a page. `epub.ts` and `dots-book.ts` each
 * turn what a model saw into XHTML documents, and everything either of them
 * knows about a book — where the chapters divide, which paragraph runs over a
 * page turn, which superscript names which note — is already spent by the time
 * those documents exist. So the plain-text book is built FROM THE DOCUMENTS
 * rather than beside them: one route through the assembly, two ways of writing
 * the answer down, and no second set of rules to keep in step with the first.
 * `--format txt` changes the last stage of a run and nothing before it, which
 * is why reconverting a banked book to text costs no GPU at all.
 *
 * THE TAG TABLE IS EXHAUSTIVE, AND A TAG THAT IS NOT IN IT STOPS THE RUN. Every
 * element either emitter writes has a rule in `elementText`; anything else
 * names itself and fails (ARCHITECTURE §8). The alternative — passing over what
 * has no rule — is the failure this format is most exposed to, because it is
 * undetectable: an EPUB that lost a `<table>` shows a hole somebody can see,
 * and a text file that lost one just reads as a book that never had a table in
 * it. The tags are not all foundry's own, either. A Table block's text is the
 * model's own HTML (`checkTableHtml`), so the table half of the table below is
 * a statement about what a model may write, and a run that meets a new one is
 * meant to be an error somebody reads.
 *
 * WHAT PLAIN TEXT CANNOT CARRY, IT DOES NOT PRETEND TO.
 *
 *  - A footnote reference becomes `[14]`, and its note `[14] …` at the end of
 *    the chapter. There is nothing to link to, so a number the reader can match
 *    by eye is the whole of what a marker can still do.
 *  - A picture becomes its alt text in brackets — which page it was cropped
 *    from — because the crop itself is a PNG in a container this format has not
 *    got.
 *  - A list item gets NO invented bullet or number. The dots route leaves the
 *    book's own `1.` at the front of the item's text and the markdown dialects
 *    strip it, and one rule here cannot be right about both: a marker added
 *    would double the first while inventing one for the second. Whatever the
 *    book printed is in the text, and nothing else is.
 */
import { decodeEntities, findElement, parseXml, type XmlElement, type XmlNode } from '../epub/xml.js';
import type { VlmDocument, VlmEpubMetadata } from './epub.js';

export class VlmTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmTextError';
  }
}

/** What `--format` chooses between. */
export type VlmOutputFormat = 'epub' | 'txt';

export const VLM_OUTPUT_FORMATS: readonly VlmOutputFormat[] = ['epub', 'txt'];

/** The extension a format's own files carry, and the only one it answers to. */
const FORMAT_EXTENSION: Readonly<Record<VlmOutputFormat, string>> = {
  epub: '.epub',
  txt: '.txt',
};

/**
 * Does `--out` say one thing and `--format` another? The message, or null.
 *
 * REFUSED RATHER THAN RESOLVED, either way round. Renaming the file would mean
 * writing somewhere nobody asked for, and honouring the extension would mean
 * ignoring the flag — and both are the shape of failure this program exists to
 * refuse (ARCHITECTURE §8). The caller names the file; foundry never invents a
 * name (see `OUT_PATH` in commands.ts).
 *
 * Only a KNOWN format's extension can contradict anything. `--out notes.md`
 * under `--format txt` is not a contradiction: `.md` makes no claim about which
 * of foundry's two output formats the file holds, and a rule that refused every
 * extension but its own would be foundry having an opinion about what a person
 * may call their own file.
 *
 * Returns the sentence instead of throwing because the same rule is broken at
 * two layers with two exit codes behind it — a typo on the command line is a
 * usage error (2) and a caller of `vlmConvert` passing the pair is a run that
 * failed (1) — and one wrong pairing deserves one wording.
 */
export function formatConflict(outPath: string, format: VlmOutputFormat): string | null {
  const extension = /\.[^./\\]+$/.exec(outPath)?.[0].toLowerCase() ?? '';
  const claimed = VLM_OUTPUT_FORMATS.find((candidate) => FORMAT_EXTENSION[candidate] === extension);
  if (claimed === undefined || claimed === format) return null;
  return `--format ${format} writes ${FORMAT_EXTENSION[format]} and --out names "${outPath}", which `
    + `is ${FORMAT_EXTENSION[claimed]}. Change one of them: a ${FORMAT_EXTENSION[claimed]} holding `
    + `${format === 'txt' ? 'plain text' : 'a zip'} is a file that opens wrong everywhere, and `
    + 'foundry does not rename a file somebody chose.';
}

// ── the shape of the page ───────────────────────────────────────────────────

/** How far a quotation is set in, the one indent this format uses. */
const QUOTE_INDENT = '    ';

/** A row's cells, and the only thing plain text can do about a table. */
const CELL_SEPARATOR = ' | ';

/** `<hr/>`: the notes rule at a chapter's end, and a thematic break in prose. */
const RULE = '----';

/** Between two chapters. One more blank line than anything inside one. */
const CHAPTER_GAP = '\n\n\n';

// ── the walk ────────────────────────────────────────────────────────────────

function nodeText(node: XmlNode, source: string): string {
  if (node.kind === 'element') return elementText(node, source);
  // A comment or a processing instruction is not the book's words. Neither
  // emitter writes one inside a chapter; a model's own table fragment may, and
  // it is still not content when it does.
  if (node.kind === 'other') return '';
  return decodeEntities(source.slice(node.start, node.end)).replace(/\s+/g, ' ');
}

function childrenText(el: XmlElement, source: string): string {
  return el.children.map((child) => nodeText(child, source)).join('');
}

/**
 * The element children only.
 *
 * Used where the child list is a STRUCTURE rather than a sentence — a row's
 * cells, a list's items — and the only text between those children is the
 * newline the emitter indented its own markup with.
 */
function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((child): child is XmlElement => child.kind === 'element');
}

/**
 * A block's own content: entities decoded, and the whitespace that belongs to
 * the markup rather than to the book taken back out.
 *
 * The one newline a block may legitimately contain is a `<br/>` — a line the
 * page broke on purpose, which `dotsInline` writes as `<br/>\n` so the XHTML
 * stays readable. The newline in that pair is the emitter's formatting and the
 * break is the book's, so the break survives and the indentation after it does
 * not.
 */
function blockContent(el: XmlElement, source: string): string {
  return childrenText(el, source).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

/** A block stands alone: a blank line before it and a blank line after. */
function paragraph(text: string): string {
  return text.length === 0 ? '' : `\n\n${text}\n\n`;
}

/**
 * A heading, ruled underneath in the character its rank is written in.
 *
 * Measured against the LONGEST line, because a heading the printer set over two
 * lines arrives here with its `<br/>` intact and a rule that stopped at the
 * last line would look like a mistake rather than a heading.
 */
function underline(text: string, rule: string): string {
  const width = Math.max(...text.split('\n').map((line) => line.length));
  return `${text}\n${rule.repeat(width)}`;
}

function indent(text: string, pad: string): string {
  return text.split('\n').map((line) => (line.length === 0 ? line : pad + line)).join('\n');
}

/**
 * One blank line where blocks meet, never more, and no trailing spaces.
 *
 * Leading whitespace is deliberately left alone: it is a quotation's indent by
 * the time this runs, and the only thing that could have put it there.
 */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A table's rows, from a `<table>` or from one of its row groups. */
function tableRows(el: XmlElement, source: string): string[] {
  return elementChildren(el)
    .map((child) => elementText(child, source).trim())
    .filter((row) => row.length > 0);
}

function elementText(el: XmlElement, source: string): string {
  switch (el.tag) {
    // ── containers, which are nothing but what is inside them ──────────────
    // Their children are blocks and carry their own spacing: `<section>` wraps
    // the footnotes and whatever a page classified itself as, and `<div>` is
    // the table wrapper that exists to let a wide table scroll in a reader.
    case 'body': case 'section': case 'div':
      return childrenText(el, source);

    // ── inline markup, which plain text has no way to keep ─────────────────
    // `<a>` included: a noteref and a backlink are both links to somewhere in a
    // file that has no anywhere. What they wrap is the number, and the number
    // is the part that still works.
    case 'a': case 'em': case 'strong': case 'i': case 'b': case 'span': case 'sub':
      return childrenText(el, source);

    /*
     * Every superscript is bracketed, and that one rule covers both ends of a
     * footnote. `dotsInline` writes a reference in the prose as a `<sup>`,
     * linked or plain, and `buildChapterBody` opens the note itself with the
     * same element — so `[14]` appears in the paragraph and `[14] …` on the
     * note without either side of this file knowing about the other.
     *
     * NOTHING HERE KNOWS --strip-note-markers EXISTS, and that is the point:
     * under that flag `dotsInline` deletes the superscript run before an
     * element is written at all, so there is no `<sup>` in the document to
     * bracket. The flag is obeyed once, upstream, for both formats.
     */
    case 'sup':
      return `[${childrenText(el, source)}]`;

    case 'br':
      return '\n';

    /*
     * The alt text, bracketed, and it is the only honest thing left. The
     * picture is a cropped PNG in the EPUB's container (`dots-book.ts`) and
     * this format has no container to put it in, so what survives is that a
     * figure was here and which page it came off — which is exactly the
     * sentence the alt already carries.
     */
    case 'img': {
      const alt = el.attrs.get('alt') ?? '';
      return alt.length > 0 ? `[${alt}]` : '[figure]';
    }

    // ── the blocks ─────────────────────────────────────────────────────────
    case 'h1': case 'h2': case 'h3': {
      const text = blockContent(el, source);
      if (text.length === 0) return '';
      // Three ranks, told apart the way a typewriter told them apart. h3 is
      // left bare rather than given a third rule character: the blank lines
      // around it already say it is a heading, and a book with three kinds of
      // underline in it is a book that has started decorating.
      if (el.tag === 'h3') return paragraph(text);
      return paragraph(underline(text, el.tag === 'h1' ? '=' : '-'));
    }

    case 'p': case 'aside': case 'figure':
      return paragraph(blockContent(el, source));

    case 'blockquote':
      // Tidied BEFORE it is indented and never after: the outer pass leaves
      // leading whitespace alone precisely so that this indent survives it.
      return paragraph(indent(tidy(childrenText(el, source)), QUOTE_INDENT));

    case 'hr':
      return paragraph(RULE);

    case 'ol': case 'ul': {
      const items = elementChildren(el)
        .map((item) => elementText(item, source).trim())
        .filter((item) => item.length > 0);
      return paragraph(items.join('\n'));
    }
    case 'li':
      return blockContent(el, source);

    case 'table':
      return paragraph(tableRows(el, source).join('\n'));
    case 'thead': case 'tbody': case 'tfoot':
      return tableRows(el, source).join('\n');
    case 'tr':
      return elementChildren(el)
        .map((cell) => elementText(cell, source).trim())
        .join(CELL_SEPARATOR);
    case 'td': case 'th': case 'caption':
      return blockContent(el, source);
    // A column declaration is the table's geometry and carries no words at all.
    // Plain text has no columns to declare, so there is nothing to lose here.
    case 'colgroup': case 'col':
      return '';

    default:
      throw new VlmTextError(
        `<${el.tag}> has no plain-text rule, so a book written as text would arrive short by`
        + ' whatever it was holding. Every element foundry or a model can put in a chapter is in'
        + ' the table in src/vlm/text-out.ts; add this one there rather than letting the text'
        + ' lose it silently.',
      );
  }
}

// ── the book ────────────────────────────────────────────────────────────────

/**
 * One chapter's XHTML as plain text, under its title.
 *
 * The label is written above the chapter EXCEPT where the chapter already opens
 * with it. A section's label is usually its own first heading — `buildChapterBody`
 * takes it from exactly there — so printing both would print the chapter's name
 * twice. The test is the RENDERED form of each rather than the strings behind
 * them: if the body opens with this label ruled the way a heading is ruled, it
 * is the heading the label was taken from, and no separate rule about where
 * labels come from has to be kept true here. When they differ, both are kept,
 * because a label a page classified — `Copyright`, `Part IV THE DEFENSE` — is
 * the only name that section has and a text file has no nav document to carry
 * it instead.
 */
export function chapterText(label: string, xhtml: string): string {
  let root: XmlElement;
  try {
    root = parseXml(xhtml, 'xhtml');
  } catch (err) {
    throw new VlmTextError(
      `the chapter "${label}" is not well-formed XHTML `
      + `(${err instanceof Error ? err.message : String(err)}), so it cannot be read back as text.`,
    );
  }
  const body = findElement(root, 'body');
  if (body === undefined) {
    throw new VlmTextError(
      `the chapter "${label}" has no <body>, so there is nothing in it to read out.`,
    );
  }

  const walked = tidy(elementText(body, xhtml));
  if (label.trim().length === 0) return walked;
  const title = underline(label, '=');
  if (walked === title || walked.startsWith(`${title}\n`)) return walked;
  return walked.length === 0 ? title : `${title}\n\n${walked}`;
}

/**
 * The whole book as one plain-text file.
 *
 * THE TITLE AND THE AUTHOR ARE AT THE TOP BECAUSE THERE IS NOWHERE ELSE. An
 * EPUB states them as `dc:title` and `dc:creator` in a package document that
 * every reading system knows how to ask; a text file has no package and no
 * metadata of any kind, so the only place the book can say what it is, is in
 * the text. Neither is invented — `convert.ts` takes the title from the PDF or
 * from the filename and names no author the PDF did not.
 *
 * Returns the shape `packageVlmEpub` returns, `zipSeconds` and all. That phase
 * is "the assembled documents become the bytes that get written", and a text
 * book pays it too — it is a render rather than a zip. The run's phase line
 * says which of the two it was (`convert.ts`), so the number is never printed
 * under a word that is wrong about it.
 */
export function packageVlmText(
  metadata: VlmEpubMetadata,
  documents: readonly VlmDocument[],
): { bytes: Uint8Array; zipSeconds: number } {
  if (documents.length === 0) {
    throw new VlmTextError('no text survived the pages — there is no book to write');
  }
  const started = Date.now();
  const front = metadata.author === undefined
    ? underline(metadata.title, '=')
    : `${underline(metadata.title, '=')}\n${metadata.author}`;
  const chapters = documents
    .map((document) => chapterText(document.label, document.xhtml))
    .filter((chapter) => chapter.length > 0);
  // A trailing newline, because a text file that does not end in one is a text
  // file half the tools that will touch this book complain about.
  const bytes = new TextEncoder().encode(`${[front, ...chapters].join(CHAPTER_GAP)}\n`);
  return { bytes, zipSeconds: (Date.now() - started) / 1000 };
}
