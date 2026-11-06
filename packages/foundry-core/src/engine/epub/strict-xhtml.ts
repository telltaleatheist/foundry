/**
 * strict-xhtml — a fragment of HTML the vision model wrote, written back out as
 * strict XHTML.
 *
 * ── WHY TABLES, AND WHY HERE ────────────────────────────────────────────────
 *
 * A Table block's text is the model's own HTML, and it went into the book as
 * the model wrote it (`checkTableHtml`, vlm/dots.ts): bare `<br>`, `&nbsp;`, a
 * raw `&`, `<td nowrap>`, `width=50`, `<TD>` closed by `</td>`. The lenient
 * parser that checked it reads all of that, so the export filed it — and a
 * reading system parses an EPUB's documents as XML, where every one of those
 * stops the parse and the reader sees nothing. Prose never had the problem: it
 * is written through `esc` from text. So the fix is at the one door every table
 * enters the book through, and the export check (vlm/epub.ts) is made strict in
 * the same change, because a strict check alone would only turn these exports
 * into refusals (Owen, 2026-11-06, on the lead's recommendation).
 *
 * ── NOT A REPAIR ─────────────────────────────────────────────────────────────
 *
 * Nothing structural is guessed: the fragment has already been parsed, and a
 * tag that does not close was refused there, by page. This only changes how
 * the SAME tree is spelled. Tags are lower-cased, every attribute is quoted and
 * has a value (a valueless one takes its own name, as HTML defines), a void
 * element closes itself, a named reference becomes the character it names
 * (`html-entities.ts`, the full HTML list), and `&`, `<` and `>` in text are
 * escaped. A name not in the HTML list is left visible as written, with its `&`
 * escaped, rather than guessed at. Characters XML forbids outright (C0 controls
 * other than tab, newline and return) are dropped: no XML document can carry
 * them, in any spelling.
 *
 * Comments are kept, with any `--` inside broken apart; CDATA becomes escaped
 * text; a processing instruction or doctype inside a table is dropped.
 */
import { HTML_ENTITIES } from './html-entities.js';
import { parseXml, type XmlElement, type XmlNode } from './xml.js';

/**
 * Characters no XML 1.0 document may contain, in any spelling: C0 controls
 * other than tab, newline and return, U+FFFE and U+FFFF, and a LONE surrogate.
 * The `u` flag is what makes the surrogate range match only a half with no
 * partner \u2014 a real pair is one code point to it, and passes.
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu;

/**
 * `fragment` respelled as strict XHTML. Throws whatever the lenient parse
 * throws for markup whose structure is broken — the caller has checked it
 * already, and this never guesses a tree.
 */
export function strictXhtmlFragment(fragment: string): string {
  const wrapped = `<strict-xhtml-fragment>${fragment}</strict-xhtml-fragment>`;
  const doc = parseXml(wrapped, 'xhtml');
  const wrapper = doc.children.find((child): child is XmlElement => child.kind === 'element');
  if (wrapper === undefined) return '';
  let out = '';
  for (const child of wrapper.children) out += written(wrapped, child);
  return out;
}

function written(source: string, node: XmlNode): string {
  if (node.kind === 'text') return escText(decodeAll(source.slice(node.start, node.end)));
  if (node.kind === 'other') {
    if (node.what === 'comment') {
      return `<!--${source.slice(node.innerStart, node.innerEnd).replace(/--/g, '- -').replace(/-$/, '- ')}-->`;
    }
    if (node.what === 'cdata') return escText(source.slice(node.innerStart, node.innerEnd).replace(FORBIDDEN, ''));
    return '';
  }
  let attrs = '';
  for (const [name, raw] of rawAttrs(source.slice(node.start, node.innerStart))) {
    attrs += ` ${name}="${escAttr(decodeAll(raw))}"`;
  }
  if (node.selfClosing && node.children.length === 0 && VOID.has(node.tag)) return `<${node.tag}${attrs}/>`;
  let inner = '';
  for (const child of node.children) inner += written(source, child);
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/**
 * HTML's void elements: the only ones written self-closed. Any other element
 * written as `<td/>` comes back out as `<td></td>`, which every parser reads the
 * same way.
 */
const VOID: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * A start tag's attributes AS WRITTEN, in order, names lower-cased and the first
 * of a repeated name kept — the parser's own reading of the tag, which this
 * mirrors. The parser hands back values decoded through its short list of
 * names (epub/xml.ts), so `&oelig;` would arrive still spelled; reading the raw
 * value here lets it be decoded through the full list, exactly as text is. A
 * valueless attribute takes its own name, as HTML defines.
 */
function rawAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const nameChar = /[-A-Za-z0-9_:.]/;
  let j = 1;
  while (j < tag.length && nameChar.test(tag[j]!)) j++;
  for (;;) {
    while (j < tag.length && /\s/.test(tag[j]!)) j++;
    if (j >= tag.length || tag[j] === '>' || tag[j] === '/') return attrs;
    const at = j;
    while (j < tag.length && nameChar.test(tag[j]!)) j++;
    const name = tag.slice(at, j).toLowerCase();
    while (j < tag.length && /\s/.test(tag[j]!)) j++;
    let value = name;
    if (tag[j] === '=') {
      j++;
      while (j < tag.length && /\s/.test(tag[j]!)) j++;
      const quote = tag[j];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, j + 1);
        value = tag.slice(j + 1, close);
        j = close + 1;
      } else {
        const from = j;
        while (j < tag.length && !/[\s>]/.test(tag[j]!)) j++;
        value = tag.slice(from, j);
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
}

/** Every reference in raw text, decoded through the full HTML list; an unknown name stays as written. */
function decodeAll(raw: string): string {
  return raw.replace(/&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return HTML_ENTITIES[name] ?? whole;
      const code = Number.parseInt(dec ?? hex!, dec !== undefined ? 10 : 16);
      // Past Unicode, or a surrogate half: no character XML can hold.
      return code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '' : String.fromCodePoint(code);
    }).replace(FORBIDDEN, '');
}

function escText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(value: string): string {
  return escText(value.replace(FORBIDDEN, '')).replace(/"/g, '&quot;');
}
