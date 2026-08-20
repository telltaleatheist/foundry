// THE CASCADE CHECK: which rule wins, rather than what the rules compute.
//
// A model of a transform said the capture card's draw was right while it was
// wrong, because `.page img { height: auto }` sat LATER at equal specificity
// than `.spun img { height: 100% }` and quietly won. Twenty assertions about the
// arithmetic could not see it, and neither can four gates: a later rule winning
// is not an error, it is how CSS works.
//
// So this asks the other question, and it asks it of REAL ELEMENTS.
//
// ── WHY IT READS THE TEMPLATE ──────────────────────────────────────────────
//
// A first version compared any two rules whose rightmost compound matched --
// `.spun img` against `.page img`. It found the defect and twenty-four other
// things, nearly all of them false: `.kind svg` and `.op svg` never style one
// element, and `.meter i:nth-child(1)` and `(2)` cannot both match. A scanner
// that cries wolf twenty-four times is a scanner nobody runs.
//
// So it builds the component's element tree from its own template and asks, per
// element, which rules actually match it -- then reports only where two of them
// set the same structural property and the later one wins.
//
// ── WHAT IT IS HONESTLY BLIND TO ───────────────────────────────────────────
//
// Elements that exist only at runtime (a child component's internals), @media
// blocks, and anything reached through ::ng-deep. Classes bound by expression
// (`[class]="x"`) are unknown, so a rule keyed on one is not resolved. Named
// here rather than implied, because a scanner quiet for a reason nobody wrote
// down is the next thing to be trusted too far.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STRUCTURAL = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'position', 'display', 'inset', 'top', 'right', 'bottom', 'left',
  'transform', 'transform-origin', 'aspect-ratio', 'flex', 'flex-direction',
  'grid-template-columns', 'object-fit', 'overflow',
]);

const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'use', 'path', 'circle', 'rect', 'line', 'polygon', 'meta', 'link']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.component.ts')) out.push(full);
  }
  return out;
}

function literalAfter(text, marker) {
  const re = new RegExp(marker, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = m.index + m[0].length;
    let i = from;
    for (; i < text.length; i += 1) if (text[i] === '`' && text[i - 1] !== '\\') break;
    out.push(text.slice(from, i));
  }
  return out;
}

/** Every element the template declares, with the classes on it and its ancestors. */
function elementsOf(template) {
  const html = template.replace(/<!--[\s\S]*?-->/g, ' ');
  const elements = [];
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  let m;
  while ((m = tag.exec(html)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosed = m[4] === '/' || VOID.has(name);
    if (closing) { stack.pop(); continue; }
    const classes = new Set();
    const plain = /class\s*=\s*"([^"]*)"/.exec(attrs);
    if (plain) for (const c of plain[1].split(/\s+/)) if (c && !c.includes('{')) classes.add(c);
    for (const bound of attrs.matchAll(/\[class\.([\w-]+)\]/g)) classes.add(bound[1]);
    const element = { name, classes, ancestors: stack.map((s) => s) };
    elements.push(element);
    if (!selfClosed) stack.push(element);
  }
  return elements;
}

function specificity(selector) {
  let s = selector;
  let ids = 0; let classes = 0; let elements = 0;
  s = s.replace(/::[a-z-]+/g, () => { elements += 1; return ' '; });
  s = s.replace(/:not\(([^)]*)\)/g, (_a, inner) => ` ${inner} `);
  s = s.replace(/#[\w-]+/g, () => { ids += 1; return ' '; });
  s = s.replace(/\.[\w-]+/g, () => { classes += 1; return ' '; });
  s = s.replace(/\[[^\]]*\]/g, () => { classes += 1; return ' '; });
  s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => { classes += 1; return ' '; });
  for (const word of s.split(/[\s>+~]+/)) if (/^[a-z][\w-]*$/i.test(word)) elements += 1;
  return ids * 10000 + classes * 100 + elements;
}

/** One compound (`.a.b`, `img`, `.x::before`) against one element. */
function compoundMatches(compound, element) {
  if (compound.includes('::')) return false;   // a pseudo-element is not this element
  if (/:nth-|:hover|:focus|:active|:disabled|:not\(|:checked/.test(compound)) return false;
  const bare = compound.replace(/:[\w-]+(\([^)]*\))?/g, '');
  const name = /^[a-zA-Z][\w-]*/.exec(bare);
  if (name && name[0].toLowerCase() !== element.name) return false;
  for (const cls of bare.matchAll(/\.([\w-]+)/g)) {
    if (!element.classes.has(cls[1])) return false;
  }
  return true;
}

/** Descendant/child chains only, which is what this codebase writes. */
function matches(selector, element) {
  if (selector.includes(',')) return false;
  if (/[+~]/.test(selector)) return false;
  const parts = selector.trim().split(/\s*>\s*|\s+/).filter(Boolean)
    .filter((p) => !p.startsWith(':host'));
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  if (!compoundMatches(key, element)) return false;
  let at = element.ancestors.length - 1;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (at >= 0) {
      if (compoundMatches(parts[i], element.ancestors[at])) { found = true; at -= 1; break; }
      at -= 1;
    }
    if (!found) return false;
  }
  return true;
}

function rulesIn(css) {
  const rules = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/@[\w-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m; let order = 0;
  while ((m = re.exec(flat)) !== null) {
    const declarations = new Map();
    for (const decl of m[2].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim().toLowerCase();
      if (prop.length === 0 || prop.startsWith('--')) continue;
      declarations.set(prop, decl.slice(at + 1).trim());
    }
    if (declarations.size === 0) continue;
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      order += 1;
      rules.push({ selector, order, spec: specificity(selector), declarations });
    }
  }
  return rules;
}

// Default to the renderer's components, so it runs with no arguments from the
// repository root the way the other scanners do.
const ROOT = process.argv[2] || path.join(HERE, '..', 'app', 'src', 'app');
const files = fs.statSync(ROOT).isDirectory() ? walk(ROOT, []) : [ROOT];

let elementsSeen = 0;
let found = 0;
let sameSelector = 0;
const seen = new Set();

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const templates = literalAfter(text, 'template:\\s*`');
  const styles = literalAfter(text, 'styles:\\s*\\[?\\s*`');
  if (templates.length === 0 || styles.length === 0) continue;
  const elements = elementsOf(templates.join('\n'));
  const rules = styles.flatMap((css) => rulesIn(css));
  elementsSeen += elements.length;

  for (const element of elements) {
    const hits = rules.filter((rule) => matches(rule.selector, element));
    for (let i = 0; i < hits.length; i += 1) {
      for (let j = i + 1; j < hits.length; j += 1) {
        const earlier = hits[i];
        const later = hits[j];
        /*
         * ONLY EQUAL SPECIFICITY, AND ONLY DIFFERENT SELECTORS.
         *
         * A HIGHER-specificity override is how a modifier is written -- .icon
         * then .icon.wide -- and is somebody saying what they meant. Reporting
         * those buries the real thing under a dozen intentional ones, which is
         * how the first version of this scanner earned twenty-four false hits.
         *
         * The accident shape is TWO SELECTORS OF EQUAL WEIGHT where the winner
         * is decided by which was typed second. Nobody expresses precedence
         * that way on purpose; the card defect was exactly this.
         */
        if (later.spec !== earlier.spec) continue;
        if (later.selector === earlier.selector) { sameSelector += 1; continue; }
        for (const [prop] of earlier.declarations) {
          if (!STRUCTURAL.has(prop)) continue;
          if (!later.declarations.has(prop)) continue;
          const where = file.replace(/\\/g, '/').split('/app/src/').pop();
          const line = where + ' | ' + earlier.selector + ' | ' + later.selector + ' | ' + prop;
          if (seen.has(line)) continue;
          seen.add(line);
          console.log(
            'LOSES  ' + where
            + '\n       on <' + element.name + (element.classes.size ? ' class="' + [...element.classes].join(' ') + '"' : '') + '>'
            + '\n       ' + earlier.selector + '  sets ' + prop
            + '\n       ' + later.selector + '  sets it again, later, at '
            + (later.spec === earlier.spec ? 'the same' : 'higher') + ' specificity',
          );
          found += 1;
        }
      }
    }
  }
}

console.log(elementsSeen + ' elements resolved, ' + found + ' rules quietly losing'
  + (sameSelector > 0 ? '  (' + sameSelector + ' same-selector redeclarations not counted)' : ''));
process.exit(found === 0 ? 0 : 1);
