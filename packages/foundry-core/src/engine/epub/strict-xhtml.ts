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

/** Characters no XML 1.0 document may contain, in any spelling. */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

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
  for (const [name, value] of node.attrs) attrs += ` ${name}="${escAttr(value)}"`;
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

/** Every reference in raw text, decoded through the full HTML list; an unknown name stays as written. */
function decodeAll(raw: string): string {
  return raw.replace(/&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return HTML_ENTITIES[name] ?? whole;
      const code = Number.parseInt(dec ?? hex!, dec !== undefined ? 10 : 16);
      return code > 0x10FFFF ? '' : String.fromCodePoint(code);
    }).replace(FORBIDDEN, '');
}

function escText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(value: string): string {
  return escText(value.replace(FORBIDDEN, '')).replace(/"/g, '&quot;');
}
