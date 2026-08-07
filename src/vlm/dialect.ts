/**
 * vlm/dialect — turning what a model wrote into what a book is made of.
 *
 * Every model in `models.ts` answers in the format IT was trained to answer in,
 * so there is one parser per dialect and no house format in between. The output
 * of all of them is the same short list of block kinds, which is the only thing
 * `epub.ts` in this directory knows how to write.
 *
 * WHAT IS DROPPED, AND WHY IT IS A DECISION RATHER THAN A FILTER. A page
 * carries two kinds of text: the book's, and the page's. The folio, the running
 * head, the JSTOR download stamp across the foot of a scanned article — none of
 * them is a sentence anybody wrote to be read, and all of them land in the
 * middle of a paragraph when the page turns. A narrator reads them aloud. The
 * Nanonets prompt asks the model to TAG exactly these (`<page_number>`,
 * `<footer>`, `<watermark>`), which is why that dialect can drop them without
 * guessing — and why the plain-markdown dialects cannot, and say so in their
 * model notes.
 *
 * Nothing else is dropped. A block this parser has no rule for STOPS the book
 * and names the page, because the alternative — skipping it — is a page that
 * silently arrives shorter than the paper it came from.
 */
import { decodeEntities, parseXml, type XmlElement, type XmlNode } from '../epub/xml.js';
import type { VlmDialect } from './models.js';

export class VlmDialectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmDialectError';
  }
}

/**
 * One thing on a page.
 *
 * `xhtml` is ready to write: escaped, with inline markup already turned into
 * elements. `text` on a heading is the same content with the markup taken back
 * out, because a heading is also a TOC label and a label is not markup.
 */
export type VlmBlock =
  | { kind: 'heading'; level: number; xhtml: string; text: string }
  | { kind: 'paragraph'; xhtml: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  /** A fragment the model wrote as HTML — a table. Verified well-formed. */
  | { kind: 'html'; xhtml: string };

export interface ParsedPage {
  blocks: VlmBlock[];
  /** Furniture removed: folios, running feet, watermarks. */
  dropped: number;
}

export function parsePage(text: string, dialect: VlmDialect, page: number): ParsedPage {
  switch (dialect) {
    case 'nanonets-markdown': return parseMarkdown(text, page, true);
    case 'markdown': return parseMarkdown(text, page, false);
    case 'qwen-html': return parseQwenHtml(text, page);
    case 'dots-json':
      // Parsed by `dots.ts`, not here, and that is not an oversight. Its answer
      // carries a box on every block, and a `VlmBlock` has nowhere to put one —
      // dropping the geometry to fit this shape would throw away the only thing
      // that dialect knows that the others do not. `convert.ts` forks on it.
      throw new VlmDialectError(
        `page ${page}: the dots-json dialect answers with geometry and is parsed by`
        + ' src/vlm/dots.ts. Nothing should reach this parser with it.',
      );
    // Every dialect in the registry is above. A new one arrives with its
    // parser, which is the whole cost of adding a model.
    default: throw new VlmDialectError(
      `page ${page}: no parser for dialect "${dialect as string}"`,
    );
  }
}

// ── inline ──────────────────────────────────────────────────────────────────

/** The five predefined entities. Same rule as `src/export/epub.ts`. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Characters XML 1.0 cannot represent at all — not escaped, not as a numeric
 * reference. A model does not usually emit one, but a page image with a
 * scanner artefact on it has produced stranger things.
 */
function stripIllegalXml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

/** Unicode superscripts, which is how these models write a footnote marker. */
const SUPERSCRIPTS: ReadonlyMap<string, string> = new Map(Object.entries({
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
}));

const SUPERSCRIPT_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g;

/**
 * Markdown inline markup → XHTML.
 *
 * Escaping happens FIRST, so a `<` in the book's prose is already `&lt;` before
 * a single element is written and cannot open one. The markdown characters are
 * untouched by escaping, which is what makes the order safe.
 *
 * A run of unicode superscript digits becomes one `<sup>`: `September¹⁴` is a
 * footnote marker, and left as raw characters it stays a marker no reading
 * system can style and no narrator can be told to skip.
 */
function inlineMarkdown(raw: string): string {
  let out = escapeXml(stripIllegalXml(raw));
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '<em>$1</em>');
  out = out.replace(/(?<![_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '<em>$1</em>');
  out = out.replace(SUPERSCRIPT_RUN, (run) => {
    const digits = [...run].map((c) => SUPERSCRIPTS.get(c) ?? c).join('');
    return `<sup>${digits}</sup>`;
  });
  return out;
}

/** Markup back out, for a heading used as a TOC label. */
function plainText(xhtml: string): string {
  return decodeEntities(xhtml.replace(/<[^>]*>/g, '')).trim();
}

// ── markdown ────────────────────────────────────────────────────────────────

/**
 * The furniture tags the Nanonets prompt asks for, stripped WITH their content
 * before anything else looks at the page.
 *
 * Whole-text and non-greedy rather than line-by-line, because a `<footer>` runs
 * to three lines on a JSTOR article and a line-based rule would drop the first
 * of them and narrate the other two.
 */
const FURNITURE = /<(page_number|footer|header|watermark)>[\s\S]*?<\/\1>/g;

/**
 * `<img>a description</img>` — the model's own tag, which is not an XHTML img.
 *
 * Two spellings of one pattern because a /g regex carries `lastIndex` between
 * calls: the tested one must not, and the replacing one must.
 */
const IMG_TAG = /<img>([\s\S]*?)<\/img>/;
const IMG_TAG_ALL = /<img>([\s\S]*?)<\/img>/g;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const TABLE_OPEN = /^\s*<table[\s>]/i;

function parseMarkdown(source: string, page: number, furniture: boolean): ParsedPage {
  let dropped = 0;
  let text = source;
  if (furniture) {
    text = text.replace(FURNITURE, () => { dropped += 1; return ''; });
  }

  const blocks: VlmBlock[] = [];
  const paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    // Joined with a single space. These models reflow: a paragraph arrives as
    // one long line, and where it does wrap the break is the model's line
    // width rather than the page's. That is the opposite of the scan pipeline,
    // where a line break is a fact about the paper and a line-final hyphen has
    // to be resolved (src/export/linejoin.ts) — there is nothing to resolve
    // here, because nothing was broken by a column.
    blocks.push({ kind: 'paragraph', xhtml: inlineMarkdown(paragraph.join(' ')) });
    paragraph.length = 0;
  };
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(inlineMarkdown) });
    list = null;
  };
  const flush = (): void => { flushParagraph(); flushList(); };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) { flush(); continue; }

    if (TABLE_OPEN.test(line)) {
      flush();
      const start = i;
      while (i < lines.length && !/<\/table>/i.test(lines[i])) i++;
      if (i === lines.length) {
        throw new VlmDialectError(
          `page ${page}: a <table> was opened and never closed. The model's answer is `
          + 'malformed, and a table guessed shut is a table with somebody else\'s rows in it.',
        );
      }
      blocks.push({ kind: 'html', xhtml: wellFormed(lines.slice(start, i + 1).join('\n'), page) });
      continue;
    }

    if (IMG_TAG.test(trimmed)) {
      flush();
      // The model's `<img>` carries a DESCRIPTION as its content and no src —
      // it is not the XHTML void element and cannot be passed through as one.
      // What the model saw is written as text, marked, so a reader knows the
      // sentence describes a picture rather than being one.
      const described = trimmed.replace(IMG_TAG_ALL, (_m, inner: string) => String(inner).trim());
      blocks.push({ kind: 'html', xhtml: `<p class="image">${inlineMarkdown(described)}</p>` });
      continue;
    }

    if (RULE.test(trimmed)) { flush(); blocks.push({ kind: 'html', xhtml: '<hr/>' }); continue; }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      const xhtml = inlineMarkdown(heading[2].trim());
      blocks.push({ kind: 'heading', level: heading[1].length, xhtml, text: plainText(xhtml) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet?.[1] ?? numbered![1]).trim());
      continue;
    }

    // A line under an open list item continues it — the item's own wrap, same
    // reasoning as a paragraph's.
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }

    paragraph.push(trimmed);
  }
  flush();

  return { blocks, dropped };
}

// ── QwenVL HTML ─────────────────────────────────────────────────────────────

/** Inline elements this parser will carry into the book, with attributes off. */
const INLINE_TAGS: ReadonlySet<string> = new Set(['em', 'i', 'b', 'strong', 'sup', 'sub', 'br', 'span']);

const INLINE_RENAME: ReadonlyMap<string, string> = new Map(Object.entries({
  i: 'em', b: 'strong', span: 'span',
}));

/**
 * Qwen2.5-VL's document format: one element per block, each carrying the box it
 * was read from.
 *
 * The boxes are DROPPED. They are the reason to ask this model in this format —
 * it is what stops it inventing geometry — but a book is not a layout, and a
 * `data-bbox` in the finished EPUB would be a coordinate in a page image nobody
 * kept.
 */
function parseQwenHtml(source: string, page: number): ParsedPage {
  // The model answers with a fragment, and a fragment has no single root. It
  // also sometimes wraps its answer in ```html — the fence is the chat habit,
  // not the format, so it comes off before parsing.
  const fragment = source.replace(/^\s*```(?:html)?\s*/i, '').replace(/```\s*$/i, '');
  // Wrapped, and every offset below is into THIS string — the parser records
  // source ranges, so the string it parsed is the string that gets sliced.
  const wrapped = `<foundry-vlm-page>${fragment}</foundry-vlm-page>`;
  let root: XmlElement;
  try {
    root = parseXml(wrapped, 'xhtml');
  } catch (err) {
    throw new VlmDialectError(
      `page ${page}: the model's HTML does not parse (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const holder = root.children.find((n): n is XmlElement => n.kind === 'element')!;
  const ctx: QwenContext = { source: wrapped, page, dropped: 0 };

  const blocks: VlmBlock[] = [];
  for (const child of holder.children) {
    if (child.kind === 'text') {
      // Loose text between blocks is the model forgetting its own format for a
      // moment. It is still the book's words, so it becomes a paragraph.
      const loose = decodeEntities(wrapped.slice(child.start, child.end)).trim();
      if (loose.length > 0) blocks.push({ kind: 'paragraph', xhtml: escapeXml(stripIllegalXml(loose)) });
      continue;
    }
    if (child.kind === 'other') continue;
    blocks.push(...qwenBlock(child, ctx));
  }
  return { blocks, dropped: ctx.dropped };
}

/** The wrapped source every offset indexes, plus what has been dropped from it. */
interface QwenContext {
  source: string;
  page: number;
  dropped: number;
}

function qwenBlock(el: XmlElement, ctx: QwenContext): VlmBlock[] {
  switch (el.tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const xhtml = qwenInline(el, ctx);
      return [{ kind: 'heading', level: Number(el.tag.slice(1)), xhtml, text: plainText(xhtml) }];
    }
    case 'p': case 'blockquote': case 'address':
      return [{ kind: 'paragraph', xhtml: qwenInline(el, ctx) }];
    case 'ul': case 'ol': {
      const items = el.children
        .filter((n): n is XmlElement => n.kind === 'element' && n.tag === 'li')
        .map((li) => qwenInline(li, ctx));
      return [{ kind: 'list', ordered: el.tag === 'ol', items }];
    }
    case 'table':
      return [{ kind: 'html', xhtml: wellFormed(ctx.source.slice(el.start, el.end), ctx.page) }];
    case 'div': case 'section': case 'article': case 'body':
      return el.children
        .filter((n): n is XmlElement => n.kind === 'element')
        .flatMap((n) => qwenBlock(n, ctx));
    case 'hr':
      return [{ kind: 'html', xhtml: '<hr/>' }];
    case 'img':
      // A picture, located and nothing else: this dialect's `<img>` is the void
      // element with a box on it, carrying no description and no extractable
      // file. This mode makes a book out of the TEXT on a page, so there is
      // nothing here to write — and it is counted rather than ignored, so the
      // page's report says a picture was on it.
      ctx.dropped += 1;
      return [];
    default:
      throw new VlmDialectError(
        `page ${ctx.page}: the model emitted a <${el.tag}> block, which this dialect has no rule`
        + ' for. Add it to the block table in dialect.ts rather than letting the page arrive short.',
      );
  }
}

/** An element's content, with inline markup kept and every attribute dropped. */
function qwenInline(el: XmlElement, ctx: QwenContext): string {
  const parts: string[] = [];
  for (const child of el.children as readonly XmlNode[]) {
    if (child.kind === 'text') {
      parts.push(escapeXml(stripIllegalXml(
        decodeEntities(ctx.source.slice(child.start, child.end)),
      )));
      continue;
    }
    if (child.kind === 'other') continue;
    if (!INLINE_TAGS.has(child.tag)) {
      throw new VlmDialectError(
        `page ${ctx.page}: <${child.tag}> turned up inside a <${el.tag}>, and this dialect only`
        + ` carries ${[...INLINE_TAGS].join(', ')} as inline markup`,
      );
    }
    const tag = INLINE_RENAME.get(child.tag) ?? child.tag;
    if (child.selfClosing || child.tag === 'br') { parts.push(`<${tag}/>`); continue; }
    parts.push(`<${tag}>${qwenInline(child, ctx)}</${tag}>`);
  }
  return parts.join('').trim();
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * A raw HTML fragment, checked before it goes into a book.
 *
 * An EPUB's documents are XHTML, which is XML, and a reading system given a
 * document that does not parse shows the reader NOTHING — not the broken table,
 * the whole file. So a fragment the model wrote is parsed here, and a fragment
 * that does not parse fails the run naming the page. It is never repaired: a
 * guessed-shut tag moves somebody's rows into somebody else's table.
 */
function wellFormed(fragment: string, page: number): string {
  try {
    parseXml(`<foundry-vlm-fragment>${fragment}</foundry-vlm-fragment>`, 'xhtml');
  } catch (err) {
    throw new VlmDialectError(
      `page ${page}: the model wrote an HTML fragment that is not well-formed XHTML `
      + `(${err instanceof Error ? err.message : String(err)}). The fragment starts: `
      + `${fragment.slice(0, 120)}`,
    );
  }
  return fragment.trim();
}
