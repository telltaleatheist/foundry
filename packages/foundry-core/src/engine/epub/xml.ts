/**
 * xml — an XHTML/XML parser that never forgets where anything came from.
 *
 * WHY A PARSER AND NOT A LIBRARY: foundry has no runtime dependencies
 * (ARCHITECTURE §1), and more importantly no DOM library gives the property
 * this stage needs. `foundry footnotes --epub` edits a publisher's book, and
 * the promise is that a document it did not touch comes back BYTE-IDENTICAL and
 * a document it did touch differs only where a marker was removed. That is
 * unachievable by parse→mutate→serialize: every serializer normalises something
 * — attribute quoting, entity spelling, self-closing syntax, whitespace in the
 * prolog — and each of those is an invisible diff across a whole book.
 *
 * So nothing here serializes. Every node carries its OFFSETS INTO THE SOURCE
 * STRING, edits are computed as source-range splices, and the output is the
 * input string with those ranges cut out. Untouched bytes are untouched by
 * construction rather than by care.
 *
 * The parser is strict about structure and forgiving about nothing:
 * a mismatched end tag, an unclosed element and an unterminated tag are each an
 * error that names the offset. A tree guessed from broken markup would put an
 * element removal in the wrong place, which in this stage means deleting a span
 * of somebody's book.
 */

/** A parse that cannot continue. Always says where. */
export class XmlError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'XmlError';
  }
}

export interface XmlText {
  kind: 'text';
  /** Source range of the raw text, entities and all. */
  start: number;
  end: number;
  parent: XmlElement;
}

/**
 * Comments, processing instructions, doctypes and CDATA sections.
 *
 * They are kept in the tree — with their spans — rather than dropped, because
 * dropping them would make the child list a lie about what lies between two
 * elements, and this stage cares about spans.
 *
 * CDATA carries its own inner range, since its content IS text (no entity
 * decoding) and a paragraph may legitimately hold some.
 */
export interface XmlOther {
  kind: 'other';
  what: 'comment' | 'pi' | 'doctype' | 'cdata';
  start: number;
  end: number;
  /** For CDATA: the range of the payload between `<![CDATA[` and `]]>`. */
  innerStart: number;
  innerEnd: number;
  parent: XmlElement;
}

export interface XmlElement {
  kind: 'element';
  /** The tag name as written. */
  name: string;
  /** Lower-cased name — what every rule in this stage matches on. */
  tag: string;
  /** Attributes, keyed by lower-cased name, values entity-decoded. */
  attrs: Map<string, string>;
  /** Source range of the whole element, `<p …>` through `</p>`. */
  start: number;
  end: number;
  /** Source range of the content between the tags. Equal when self-closed. */
  innerStart: number;
  innerEnd: number;
  selfClosing: boolean;
  children: XmlNode[];
  /** Null only on the synthetic document root. */
  parent: XmlElement | null;
}

export type XmlNode = XmlElement | XmlText | XmlOther;

/**
 * HTML void elements, treated as self-closing whether or not they carry a slash
 * — in the 'xhtml' dialect only.
 *
 * XHTML from a sane toolchain writes `<br/>`, but "XHTML" in the wild includes
 * files with bare `<br>` and `<img …>`, and under a strict parser one of those
 * swallows the rest of the paragraph into a phantom element. That is not
 * forgiveness of broken markup — these tags cannot have content in any HTML
 * serialization, so there is nothing to guess.
 *
 * The OPF is a different language: pure XML, where `<meta property="…">value</meta>`
 * has content and an end tag. Auto-closing `meta` there makes the `</meta>`
 * appear to close its parent `<metadata>`. So void treatment is per-dialect,
 * and the OPF/container parse uses 'xml'.
 */
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

/**
 * The five XML entities, plus the HTML named entities that appear in real
 * EPUBs. Anything not in here decodes TO ITSELF, verbatim.
 *
 * That last rule is deliberate. An unknown entity is not an error — XHTML 1.1's
 * doctype declares hundreds and a book may legitimately use one — and it is not
 * something to guess at either. Left as its own source characters it stays
 * exactly where it was, maps back to its own bytes, and the worst case is that
 * the model sees `&oelig;` where a reader sees `œ`. A wrong guess, by contrast,
 * would shift every offset after it.
 */
const ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®',
  deg: '°', sect: '§', para: '¶', middot: '·',
  dagger: '†', Dagger: '‡', bull: '•', prime: '′',
  eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', ccedil: 'ç', agrave: 'à',
}));

/**
 * Decode one entity reference, or return null if this is not one.
 *
 * Returns the decoded text and how many SOURCE characters it consumed, because
 * the caller is building a map from decoded offsets back to source offsets and
 * cannot afford to re-derive the length.
 */
export function decodeEntityAt(source: string, at: number): { text: string; length: number } | null {
  if (source[at] !== '&') return null;
  const semi = source.indexOf(';', at + 1);
  // A bare `&` in text is common in the wild; it is not an entity, and it is
  // not an error either — it decodes to itself.
  if (semi < 0 || semi - at > 32) return null;
  const body = source.slice(at + 1, semi);
  if (body.length === 0) return null;

  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = hex ? body.slice(2) : body.slice(1);
    if (!/^[0-9]+$/.test(digits) && !(hex && /^[0-9A-Fa-f]+$/.test(digits))) return null;
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return null;
    return { text: String.fromCodePoint(code), length: semi - at + 1 };
  }

  const named = ENTITIES.get(body);
  if (named === undefined) return null;
  return { text: named, length: semi - at + 1 };
}

/** Entity-decode a whole string. Used for attribute values, where offsets do not matter. */
export function decodeEntities(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length;) {
    const ent = decodeEntityAt(raw, i);
    if (ent) { out += ent.text; i += ent.length; continue; }
    out += raw[i];
    i++;
  }
  return out;
}

/**
 * Parse a document into a tree whose every node knows its source span.
 *
 * The returned root is SYNTHETIC — it spans the whole source and holds the
 * prolog, the doctype and the document element as children. A real EPUB
 * document has exactly one element child, but nothing here enforces that: this
 * parser is also how the OPF is read, and refusing a stray processing
 * instruction would be a rule about XML the stage does not need.
 */
export function parseXml(source: string, dialect: 'xhtml' | 'xml' = 'xhtml'): XmlElement {
  const root: XmlElement = {
    kind: 'element', name: '#document', tag: '#document', attrs: new Map(),
    start: 0, end: source.length, innerStart: 0, innerEnd: source.length,
    selfClosing: false, children: [], parent: null,
  };

  const stack: XmlElement[] = [root];
  const top = (): XmlElement => stack[stack.length - 1]!;
  let i = 0;
  let textStart = 0;

  const flushText = (upTo: number): void => {
    if (upTo > textStart) {
      top().children.push({ kind: 'text', start: textStart, end: upTo, parent: top() });
    }
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;

    // `<` that does not begin a markup construct is text. Real books contain
    // stray `<` in prose; refusing them would fail a whole book over a typo.
    const next = source[lt + 1];
    const isMarkup = next !== undefined
      && (NAME_START.test(next) || next === '/' || next === '!' || next === '?');
    if (!isMarkup) { i = lt + 1; continue; }

    flushText(lt);

    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      if (close < 0) throw new XmlError('unterminated comment', lt);
      const end = close + 3;
      top().children.push({
        kind: 'other', what: 'comment', start: lt, end,
        innerStart: lt + 4, innerEnd: close, parent: top(),
      });
      i = textStart = end;
      continue;
    }

    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt + 9);
      if (close < 0) throw new XmlError('unterminated CDATA section', lt);
      const end = close + 3;
      top().children.push({
        kind: 'other', what: 'cdata', start: lt, end,
        innerStart: lt + 9, innerEnd: close, parent: top(),
      });
      i = textStart = end;
      continue;
    }

    if (source.startsWith('<?', lt)) {
      const close = source.indexOf('?>', lt + 2);
      if (close < 0) throw new XmlError('unterminated processing instruction', lt);
      const end = close + 2;
      top().children.push({
        kind: 'other', what: 'pi', start: lt, end,
        innerStart: lt + 2, innerEnd: close, parent: top(),
      });
      i = textStart = end;
      continue;
    }

    if (source.startsWith('<!', lt)) {
      // A doctype may carry an internal subset in brackets, which may itself
      // contain `>`. Track the bracket depth rather than taking the first `>`.
      let depth = 0;
      let j = lt + 2;
      for (; j < source.length; j++) {
        const ch = source[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      if (j >= source.length) throw new XmlError('unterminated declaration', lt);
      const end = j + 1;
      top().children.push({
        kind: 'other', what: 'doctype', start: lt, end,
        innerStart: lt + 2, innerEnd: j, parent: top(),
      });
      i = textStart = end;
      continue;
    }

    if (next === '/') {
      let j = lt + 2;
      while (j < source.length && NAME_CHAR.test(source[j]!)) j++;
      const name = source.slice(lt + 2, j);
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] !== '>') throw new XmlError(`unterminated end tag </${name}`, lt);
      const end = j + 1;
      const tag = name.toLowerCase();

      const open = top();
      if (open === root) {
        throw new XmlError(`end tag </${name}> with nothing open`, lt);
      }
      if (open.tag !== tag) {
        throw new XmlError(`end tag </${name}> closes <${open.name}>, opened at ${open.start}`, lt);
      }
      open.innerEnd = lt;
      open.end = end;
      stack.pop();
      i = textStart = end;
      continue;
    }

    // A start tag.
    let j = lt + 1;
    while (j < source.length && NAME_CHAR.test(source[j]!)) j++;
    const name = source.slice(lt + 1, j);
    const attrs = new Map<string, string>();

    for (;;) {
      while (j < source.length && /\s/.test(source[j]!)) j++;
      const ch = source[j];
      if (ch === undefined) throw new XmlError(`unterminated start tag <${name}`, lt);
      if (ch === '>' || (ch === '/' && source[j + 1] === '>')) break;

      const attrStart = j;
      while (j < source.length && NAME_CHAR.test(source[j]!)) j++;
      if (j === attrStart) {
        throw new XmlError(`unreadable attribute in <${name}>`, j);
      }
      const attrName = source.slice(attrStart, j).toLowerCase();
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] !== '=') {
        // A valueless attribute (HTML's `<hr noshade>`); its value is its name.
        attrs.set(attrName, attrName);
        continue;
      }
      j++;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      const quote = source[j];
      let raw: string;
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, j + 1);
        if (close < 0) throw new XmlError(`unterminated attribute value in <${name}>`, j);
        raw = source.slice(j + 1, close);
        j = close + 1;
      } else {
        const valueStart = j;
        while (j < source.length && !/[\s>]/.test(source[j]!)) j++;
        raw = source.slice(valueStart, j);
      }
      attrs.set(attrName, decodeEntities(raw));
    }

    const selfClosed = source[j] === '/';
    const end = selfClosed ? j + 2 : j + 1;
    if (source[end - 1] !== '>') throw new XmlError(`unterminated start tag <${name}`, lt);

    const tag = name.toLowerCase();
    const element: XmlElement = {
      kind: 'element', name, tag, attrs,
      start: lt, end, innerStart: end, innerEnd: end,
      selfClosing: selfClosed || (dialect === 'xhtml' && VOID_TAGS.has(tag)),
      children: [], parent: top(),
    };
    top().children.push(element);
    if (!element.selfClosing) stack.push(element);
    i = textStart = end;
  }

  flushText(source.length);

  if (stack.length > 1) {
    const open = stack[stack.length - 1]!;
    throw new XmlError(`<${open.name}> is never closed`, open.start);
  }
  return root;
}

/** Depth-first walk over every element under (and including) `node`. */
export function* elements(node: XmlElement): Generator<XmlElement> {
  yield node;
  for (const child of node.children) {
    if (child.kind === 'element') yield* elements(child);
  }
}

/**
 * The tag without its namespace prefix.
 *
 * Searches match on this, because an OPF is legally `<manifest>` or
 * `<opf:manifest>` and a package that chose the prefixed spelling is not a
 * package foundry gets to refuse to read.
 */
export function localName(tag: string): string {
  const colon = tag.indexOf(':');
  return colon < 0 ? tag : tag.slice(colon + 1);
}

/** The first element with this local name, in document order. */
export function findElement(root: XmlElement, name: string): XmlElement | undefined {
  for (const el of elements(root)) {
    if (el !== root && localName(el.tag) === name) return el;
  }
  return undefined;
}

/** Every element with this local name, in document order. */
export function findElements(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const el of elements(root)) {
    if (el !== root && localName(el.tag) === name) out.push(el);
  }
  return out;
}
