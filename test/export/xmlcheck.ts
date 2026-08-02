/**
 * A minimal XML well-formedness checker, for tests only.
 *
 * Foundry has zero runtime dependencies and there is no XML parser to reach
 * for, but "the exporter emits XHTML" is worth more than a substring assertion:
 * an unescaped `&` from a scan, or one unclosed tag, produces a file that a
 * reader refuses to render AT ALL, and a test that only greps for `<p>` would
 * pass on it.
 *
 * So this checks the properties that break real readers: tags balance and nest,
 * attribute values are quoted, and every `&` starts a legal entity reference.
 * It is not a validator and does not pretend to be — it does not resolve
 * namespaces, check the DTD, or verify the EPUB profile.
 */

export class XmlError extends Error {}

const VOID_OK = new Set(['meta', 'link', 'br', 'hr', 'img']);
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/;

/**
 * Parse far enough to prove well-formedness. Returns the element names seen, in
 * document order, so a caller can assert on structure without a second parse.
 */
export function checkXml(source: string, what = '<xml>', options: { xhtml?: boolean } = {}): string[] {
  const stack: string[] = [];
  const seen: string[] = [];
  let i = 0;

  const fail = (message: string): never => {
    const line = source.slice(0, i).split('\n').length;
    throw new XmlError(`${what}:${line}: ${message}`);
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '&') {
      const rest = source.slice(i);
      if (!ENTITY.test(rest)) {
        fail(`a raw '&' that does not start an entity reference: ${JSON.stringify(rest.slice(0, 20))}`);
      }
      i += rest.match(ENTITY)![0].length;
      continue;
    }

    if (ch !== '<') {
      if (ch === '>') fail("a raw '>' in text — it must be written &gt;");
      i++;
      continue;
    }

    // Declarations, PIs and comments: skip wholesale.
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i);
      if (end < 0) fail('an unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      if (end < 0) fail('an unterminated comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i);
      if (end < 0) fail('an unterminated declaration');
      i = end + 1;
      continue;
    }

    const closing = source.startsWith('</', i);
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < source.length && /[A-Za-z0-9:_.-]/.test(source[j])) j++;
    const name = source.slice(nameStart, j);
    if (name.length === 0) fail('a tag with no name');

    // Walk the attributes so an unquoted value is caught rather than skipped.
    let selfClosing = false;
    while (j < source.length) {
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === '>') { j++; break; }
      if (source.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
      const attrStart = j;
      while (j < source.length && /[A-Za-z0-9:_.-]/.test(source[j])) j++;
      if (j === attrStart) fail(`an unparseable attribute in <${name}>`);
      const attrName = source.slice(attrStart, j);
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '=') fail(`attribute ${attrName} in <${name}> has no value`);
      j++;
      while (j < source.length && /\s/.test(source[j])) j++;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") {
        fail(`attribute ${attrName} in <${name}> has an unquoted value`);
      }
      const close = source.indexOf(quote, j + 1);
      if (close < 0) fail(`attribute ${attrName} in <${name}> has an unterminated value`);
      const value = source.slice(j + 1, close);
      if (value.includes('<')) fail(`attribute ${attrName} in <${name}> contains a raw '<'`);
      for (let k = 0; k < value.length; k++) {
        if (value[k] === '&' && !ENTITY.test(value.slice(k))) {
          fail(`attribute ${attrName} in <${name}> contains a raw '&'`);
        }
      }
      j = close + 1;
    }

    if (closing) {
      const open = stack.pop();
      if (open === undefined) fail(`</${name}> with nothing open`);
      if (open !== name) fail(`</${name}> closes <${open}>`);
    } else {
      seen.push(name);
      if (!selfClosing) {
        // Only in XHTML. The OPF has its own <meta>, which legitimately carries
        // content — applying the XHTML void rule to the package document would
        // reject a perfectly good dcterms:modified.
        if (options.xhtml && VOID_OK.has(name)) fail(`<${name}> must be self-closing in XHTML`);
        stack.push(name);
      }
    }
    i = j;
  }

  if (stack.length > 0) throw new XmlError(`${what}: unclosed ${stack.map(n => `<${n}>`).join(', ')}`);
  return seen;
}
