/**
 * epub/meta — the Dublin Core fields of a package document, read and rewritten
 * by source offset.
 *
 * A cast book's metadata is whatever `vlm-convert` was told at conversion time,
 * which for a scan is usually the PDF's filename and nothing else: no author, no
 * publisher, no date, and a title that is a filename. An imported publisher's
 * EPUB has real metadata and may still have it WRONG — a scanner's catalogue
 * entry, a title with the subtitle glued on, a `dc:creator` reading "Unknown".
 * Fixing that is not a conversion and not a curation pass; it is six strings,
 * and this is the command that writes them.
 *
 * NOTHING HERE SERIALISES THE PACKAGE, for `xml.ts`'s reason and for
 * `translate/book.ts`'s: the OPF is edited by SOURCE-OFFSET SPLICE, so every
 * field, attribute, comment, namespace declaration and byte this program does
 * not model survives untouched. Rebuilding a package from parsed values would
 * regenerate the manifest, the spine, the `<meta>` refinements and the rendition
 * properties out of foundry's idea of them, and everything the original carried
 * that foundry has no field for would silently vanish — in a document nobody
 * reads and every reading system trusts. `languageRange` in
 * `src/translate/book.ts` is the precedent this file generalises; `dc:language`
 * is spliced through that very function, so a language written here and a
 * language written by a translation are the same bytes in the same place.
 *
 * ONLY WHAT WAS GIVEN MOVES. A run that passes `--publisher` and nothing else
 * changes exactly the publisher: `dc:title` is not rewritten, not renormalised
 * and not re-indented, and the report says field by field what became what and
 * which fields were CREATED rather than updated. That distinction is the one a
 * person wants — an updated field had a wrong answer in it, a created field had
 * no answer at all, and a book that gained four elements is a different event
 * from one that had four corrected.
 *
 * THE HARD HALF IS THE FIELD THAT IS NOT THERE. Plenty of cast books carry no
 * `<dc:publisher>` and no `<dc:date>` to overwrite, so the element has to be
 * built: inside `<metadata>`, after the last Dublin Core element already there,
 * in the prefix the file's own namespace declaration binds, indented to match
 * its siblings. Everything about that placement is read off the file rather than
 * assumed, because an OPF written by a different toolchain indents with tabs, or
 * binds the DC namespace to a prefix that is not `dc`, or declares it as the
 * default namespace of `<metadata>` — and a package with a `<publisher>` element
 * in the wrong namespace is a package whose publisher no reader will ever show.
 *
 * TWO THINGS IN AN OPF POINT AT OTHER THINGS IN IT, and both would break under a
 * careless rewrite:
 *
 *  - `<package unique-identifier="pub-id">` NAMES the `dc:identifier` that
 *    identifies the book. Its TEXT is the identifier and may be rewritten; its
 *    `id` is the link and may not. Splicing only the element's content leaves
 *    the start tag — and therefore the `id` — untouched by construction, which
 *    is why this is safe rather than merely careful. Where the named identifier
 *    cannot be found the run REFUSES rather than picking whichever
 *    `dc:identifier` is first: the wrong one rewritten is a book whose package
 *    identifier and whose stated identifier are two different strings, and
 *    nothing downstream would ever say so.
 *  - EPUB 3's `<meta refines="#id" property="file-as">` elements point at
 *    metadata ids. Nothing here writes, removes or renumbers an id — updates
 *    never touch a start tag and insertions carry no `id` at all — so a
 *    refinement cannot be orphaned by this command. What a refinement CAN become
 *    is stale: correct a `dc:creator` and its `file-as` still sorts the book
 *    under the old name. Those are counted and named in the report rather than
 *    edited, because "Kershaw, Ian" is not derivable from "Ian Kershaw" in the
 *    general case and a guess written into a library sort key is worse than a
 *    stated one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { spliceAll } from '../translate/blocks.js';
import { containerFromMembers, languageRange } from '../translate/book.js';
import { readLanguage } from '../translate/languages.js';
import type { ZipMember } from '../translate/unzip.js';
import { FinalError, readEpubInput } from './final.js';
import { decodeEntities, findElement, localName, parseXml, type XmlElement } from './xml.js';

/** A package this command will not read or will not write. Always names the file or the flag. */
export class MetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The six fields
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The Dublin Core elements this command reads and writes, and no others.
 *
 * Six, because these are the six a person editing a book's record actually
 * corrects, and because each is a single string with an obvious meaning. The
 * rest of the DC set — `contributor`, `rights`, `subject`, `coverage`,
 * `relation` — is not refused on principle; it is simply not offered, and
 * adding one is an entry here plus a flag in `commands.ts`. What is deliberately
 * NOT here is anything requiring a decision about multiplicity or refinement:
 * `dc:subject` is a list in practice, and a flag that quietly replaced a list of
 * eight subjects with one would be exactly the half-obeyed instruction
 * ARCHITECTURE §8 exists to prevent.
 */
export const EPUB_META_FIELDS = ['title', 'creator', 'language', 'publisher', 'date', 'identifier'] as const;

export type EpubMetaField = (typeof EPUB_META_FIELDS)[number];

/** The namespace `dc:` is bound to in every EPUB ever published. */
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';

/** What the package says now. `null` is "the package declares none", which is a legal answer for four of the six. */
export type EpubMetadata = Record<EpubMetaField, string | null>;

/**
 * A refinement whose subject this run changed, so the refinement now describes
 * text that is no longer there.
 *
 * Reported, never edited. See this file's header.
 */
export interface StaleRefinement {
  /** The field whose element the refinement points at. */
  field: EpubMetaField;
  /** The `property` the refinement states, e.g. `file-as`, `role`, `alternate-script`. */
  property: string;
  /** What the refinement says, unchanged by this run. */
  value: string;
}

export interface MetaChange {
  field: EpubMetaField;
  /** The element as it is spelled in this file, e.g. `dc:publisher`. */
  element: string;
  /** What it said. `null` when the field was created. */
  from: string | null;
  to: string;
  /** True when no element existed and one was written into `<metadata>`. */
  created: boolean;
}

export interface EpubMetaReport {
  /** The directory edited in place, or the file written, or the input when nothing was written. */
  outPath: string;
  /** True when `--epub` was a working tree and was edited where it stands. */
  inPlace: boolean;
  /** Path of the package document inside the container. */
  opfPath: string;
  /** What `<package unique-identifier>` names, or null when it names nothing. */
  uniqueIdentifier: string | null;
  /** The metadata as it stands AFTER any writes — what `--json` prints. */
  metadata: EpubMetadata;
  /** How many elements each field has. Two `dc:creator` is legal EPUB and is refused only when set. */
  counts: Record<EpubMetaField, number>;
  /** Field by field, old → new. Empty when the run only read. */
  changes: MetaChange[];
  /** Fields given a value they already held, so nothing was spliced for them. */
  unchanged: EpubMetaField[];
  /** Refinements of a field this run changed. */
  stale: StaleRefinement[];
  /** False for a read-only run, and for a run whose every setter was a no-op. */
  written: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading the package
// ═════════════════════════════════════════════════════════════════════════════

/** The direct element children of a node, which is all `<metadata>` ever has. */
function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

/**
 * The whole package, located once and handed to everything below.
 *
 * Held as a bag of source ranges rather than as values, because every write in
 * this file is a splice and a splice needs offsets. Reading is then the same
 * walk as writing with the last step left off, which is what makes `--json`
 * report exactly what a setter would have edited.
 */
interface PackageView {
  source: string;
  /** The `<package>` element, for `unique-identifier`. */
  pkg: XmlElement;
  /** The `<metadata>` element. */
  metadata: XmlElement;
  /** Every DC element of each field, in document order. */
  byField: Map<EpubMetaField, XmlElement[]>;
  uniqueIdentifier: string | null;
}

function viewPackage(opfPath: string, source: string): PackageView {
  let root: XmlElement;
  try {
    root = parseXml(source, 'xml');
  } catch (error) {
    throw new MetaError(
      `${opfPath} is the package document and it does not parse as XML: ${(error as Error).message}. `
      + 'foundry edits this file by source offset, so it will not guess at a tree that broken markup '
      + 'only appears to describe.',
    );
  }

  const pkg = findElement(root, 'package');
  if (pkg === undefined) {
    throw new MetaError(`${opfPath} has no <package> element, so it is not a package document`);
  }

  const metadata = findElement(pkg, 'metadata');
  if (metadata === undefined) {
    throw new MetaError(
      `${opfPath} declares no <metadata> element. Every EPUB package must — it is where dc:title, `
      + 'dc:language and dc:identifier live — and foundry will not invent one: a <metadata> written '
      + 'into a package that has none is a guess about where it belongs and about which namespace '
      + 'its children are in.',
    );
  }
  if (metadata.selfClosing || metadata.innerStart === metadata.innerEnd) {
    throw new MetaError(
      `${opfPath} has an EMPTY <metadata> element. A package with no dc:title, dc:language or `
      + 'dc:identifier in it is not a valid EPUB, and there is nothing here for foundry to read a '
      + 'namespace prefix or an indentation off — every insertion this command makes is patterned '
      + 'on the elements already there.',
    );
  }

  const byField = new Map<EpubMetaField, XmlElement[]>();
  for (const field of EPUB_META_FIELDS) byField.set(field, []);
  for (const child of elementChildren(metadata)) {
    const name = localName(child.tag) as EpubMetaField;
    const bucket = byField.get(name);
    // `<meta>` and anything else the metadata carries falls out here: no field
    // has the local name `meta`, so nothing that is not a Dublin Core element of
    // one of the six can land in a bucket.
    if (bucket !== undefined) bucket.push(child);
  }

  return {
    source,
    pkg,
    metadata,
    byField,
    uniqueIdentifier: pkg.attrs.get('unique-identifier') ?? null,
  };
}

/**
 * An element's text, entities decoded and surrounding whitespace collapsed.
 *
 * Collapsed for COMPARISON and for display, never for writing: an OPF that
 * writes `<dc:title>\n      Der Staat\n    </dc:title>` states the title "Der
 * Staat", and reporting it with its indentation in it would make every value in
 * `--json` unusable in a dialog field.
 */
function textOf(source: string, el: XmlElement): string {
  return decodeEntities(source.slice(el.innerStart, el.innerEnd)).replace(/\s+/g, ' ').trim();
}

/**
 * Which `dc:identifier` the package says identifies this book.
 *
 * The link is `<package unique-identifier="pub-id">` → `<dc:identifier id="pub-id">`,
 * and it is the one pointer in an OPF whose breakage is invisible: a package
 * whose `unique-identifier` names nothing still opens in every reader, still
 * shows its title, and is a book with no identity to any catalogue, any
 * annotation store and any sync service that keys on it. So it is resolved
 * explicitly and every way it can fail is a refusal that says which half is
 * missing — never a fallback to "the first `dc:identifier`", which would be a
 * different book's identifier rewritten with this book's.
 */
function uniqueIdentifierElement(opfPath: string, view: PackageView): XmlElement {
  const identifiers = view.byField.get('identifier')!;
  const named = view.uniqueIdentifier;
  if (named === null) {
    throw new MetaError(
      `${opfPath}'s <package> carries no unique-identifier attribute, so nothing in this book says `
      + `which of its ${identifiers.length} dc:identifier element(s) identifies it. --identifier `
      + 'rewrites the one the package names, and foundry will not pick one for it: the wrong '
      + 'identifier rewritten is a book whose package and whose record disagree, and no reader '
      + 'would ever report that.',
    );
  }
  const match = identifiers.find((el) => el.attrs.get('id') === named);
  if (match === undefined) {
    const ids = identifiers.map((el) => el.attrs.get('id') ?? '(no id)').join(', ');
    throw new MetaError(
      `${opfPath}'s <package unique-identifier="${named}"> names a dc:identifier this package does `
      + `not contain (it declares ${identifiers.length}: ${ids || 'none'}). That link is already `
      + 'broken and --identifier will not paper over it by rewriting a different element — fix the '
      + 'id, or the attribute, and run this again.',
    );
  }
  return match;
}

// ═════════════════════════════════════════════════════════════════════════════
// Writing a field that is already there, and one that is not
// ═════════════════════════════════════════════════════════════════════════════

/** Text on its way into a document this program did not write. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The whitespace that opens this element's own line, or null if it does not
 * open one.
 *
 * The null case is a package written without line breaks — one long line, which
 * a minifier or a generator that never expected to be read produces — and it is
 * worth telling apart, because copying "the indentation of the line the element
 * happens to sit on" would put a new element several levels too deep.
 */
function ownLineIndent(source: string, at: number): string | null {
  let lineStart = at;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart -= 1;
  for (let i = lineStart; i < at; i += 1) {
    if (source[i] !== ' ' && source[i] !== '\t') return null;
  }
  return source.slice(lineStart, at);
}

/**
 * The prefix a new Dublin Core element is spelled with, read off the file.
 *
 * Three sources, most authoritative first, because all three are in the wild:
 * a package that declares `xmlns:dc` on `<package>` (the common shape), one
 * that declares it on `<metadata>` (which is what foundry's own emitter writes,
 * and what the EPUB 3 examples show), and one that makes the Dublin Core
 * namespace the DEFAULT namespace of `<metadata>`, where the right answer is no
 * prefix at all. Falling back to the prefix an existing element happens to use
 * covers the fourth case — a package that inherits the binding from further out
 * than this function looks.
 *
 * A package where none of the four answers, and which therefore has no Dublin
 * Core namespace anywhere near its metadata, is REFUSED. Writing `<dc:date>`
 * into it would produce an element in an undeclared prefix, which is not
 * namespace-well-formed XML and is a package some readers will refuse to open
 * — a book broken by a metadata edit, which is the one outcome this command
 * must never produce.
 */
function dcPrefix(opfPath: string, view: PackageView): string {
  for (const el of [view.metadata, view.pkg]) {
    for (const [name, value] of el.attrs) {
      if (value !== DC_NAMESPACE) continue;
      if (name === 'xmlns') return '';
      if (name.startsWith('xmlns:')) return `${name.slice(6)}:`;
    }
  }
  for (const [, elements] of view.byField) {
    const el = elements[0];
    if (el === undefined) continue;
    const colon = el.name.indexOf(':');
    return colon < 0 ? '' : el.name.slice(0, colon + 1);
  }
  throw new MetaError(
    `${opfPath} binds the Dublin Core namespace (${DC_NAMESPACE}) nowhere foundry can see it, and `
    + 'carries no dc: element to copy the spelling from. A new metadata element written into it '
    + 'would be in an undeclared prefix — not well-formed XML, and a book some readers would then '
    + 'refuse entirely.',
  );
}

/**
 * Where a new element goes, and how it is indented.
 *
 * AFTER THE LAST DUBLIN CORE ELEMENT, rather than at the end of `<metadata>`,
 * because that is where a person would have typed it: the DC block and the
 * `<meta>` refinements that follow it are two halves of the file, and a
 * `<dc:publisher>` landing under the refinements reads as an accident even
 * though the specification does not care about order. Where there is no DC
 * element at all — which `viewPackage` has already made nearly impossible, since
 * an empty `<metadata>` is refused — it goes first inside `<metadata>`.
 *
 * The indentation is COPIED from the element it is inserted after, so a file
 * indented with tabs, or with four spaces, or with none, comes out looking the
 * way it already looked. A file with no line breaks in it at all gets one line
 * break and the metadata's own indent plus two spaces, which is the only case
 * here where anything is chosen rather than read.
 */
function insertionPoint(view: PackageView): { at: number; indent: string } {
  const children = elementChildren(view.metadata);
  let anchor: XmlElement | null = null;
  for (const child of children) {
    if (view.byField.has(localName(child.tag) as EpubMetaField)) anchor = child;
  }

  if (anchor !== null) {
    const indent = ownLineIndent(view.source, anchor.start);
    if (indent !== null) return { at: anchor.end, indent };
  }

  const outer = ownLineIndent(view.source, view.metadata.start) ?? '';
  const indent = `${outer}  `;
  return { at: anchor === null ? view.metadata.innerStart : anchor.end, indent };
}

// ═════════════════════════════════════════════════════════════════════════════
// The run
// ═════════════════════════════════════════════════════════════════════════════

export interface EpubMetaOptions {
  /** An EPUB file, or the directory one was unpacked into. */
  epubPath: string;
  /** Where the edited book is written. Required for a FILE that is being written; refused for a directory. */
  outPath?: string | undefined;
  /** The fields to set. A field absent here is not touched, not read back and not renormalised. */
  set?: Partial<Record<EpubMetaField, string>> | undefined;
  log: (message: string) => void;
}

/**
 * Read the package's metadata, write whatever was given, and say what moved.
 *
 * The two halves are the same walk: `viewPackage` locates every element, the
 * setters are turned into splices against those locations, and the report is
 * built from the source AFTER the splices — so `--json` on a run that wrote
 * prints what the file now says rather than what it said when the run started,
 * which is what the dialog reading it back needs.
 */
export async function epubMeta(opts: EpubMetaOptions): Promise<EpubMetaReport> {
  const set = opts.set ?? {};
  const wanted = EPUB_META_FIELDS.filter((f) => set[f] !== undefined);

  /*
   * `--language` is validated BEFORE the book is opened, by the same function
   * that refuses `translate --to`. A `dc:language` of "German" is invalid EPUB
   * and it is invisible: the book opens, and a reading system silently
   * hyphenates by the wrong rules and reads aloud in the wrong voice. One
   * refusal, one sentence, one place it is worded.
   */
  const language = set.language;
  if (language !== undefined) readLanguage(language, '--language');

  for (const field of wanted) {
    if (set[field]!.trim() === '') {
      throw new MetaError(
        `--${field} was given an empty value. foundry does not blank a metadata field: dc:title, `
        + 'dc:language and dc:identifier are required by the specification, and an empty dc:creator '
        + 'is a claim that the book has an author whose name is nothing. Pass the new text, or '
        + 'leave the flag out and the field is not touched.',
      );
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.epubPath);
  } catch (error) {
    throw new MetaError(
      `${opts.epubPath} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}. `
      + '--epub takes an EPUB file or an unpacked EPUB directory.',
    );
  }

  /*
   * A DIRECTORY IS EDITED IN PLACE, AND A FILE IS NOT — `epub-stamp`'s rule,
   * for `epub-stamp`'s reason. The directory is the app's working tree, the
   * copy every edit already writes to, and editing it is the entire point of
   * the dialog that drives this command. The file form is somebody's `.epub`,
   * possibly the only copy of that scan there will ever be.
   *
   * `--out` is required only when the run WRITES. Reading a file's metadata is
   * the app's first act when the dialog opens, and demanding an output path for
   * a question would mean writing a copy of a 20 MB book to answer it.
   */
  const inPlace = stat.isDirectory();
  if (!inPlace && !stat.isFile()) {
    throw new MetaError(`${opts.epubPath} is neither a file nor a directory, and --epub takes one of those`);
  }
  if (!inPlace && wanted.length > 0 && (opts.outPath === undefined || opts.outPath === '')) {
    throw new MetaError(
      `${opts.epubPath} is a file, and --out says where the edited book is written. foundry never `
      + 'writes over an input: pass --out, or point --epub at an unpacked EPUB directory, which is '
      + 'edited where it stands. Reading the metadata needs no --out at all.',
    );
  }
  if (inPlace && opts.outPath !== undefined && opts.outPath !== '') {
    throw new MetaError(
      `${opts.epubPath} is a directory, so it is edited in place and --out ${opts.outPath} would not `
      + 'be written. Pass the .epub file if you want a second file; packing a working tree back into '
      + 'an archive is `foundry epub-final`.',
    );
  }

  // The same reader `epub-final` and `epub-stamp` use, and the same refusals: a
  // directory with no `mimetype`/`META-INF` is not an unpacked EPUB, and a ZIP
  // that will not parse says which entry failed. Only the class differs, so a
  // caller can tell which command raised it.
  let members: ZipMember[];
  try {
    members = readEpubInput(opts.epubPath);
  } catch (error) {
    if (error instanceof FinalError) throw new MetaError(error.message);
    throw error;
  }

  // NOT `bookFromMembers`: a book's metadata is editable whether or not anything
  // ever stamped a category into it. A publisher's EPUB imported this morning
  // has the wrong title just as often as a cast one, and refusing to fix it
  // until somebody has run `epub-stamp` would be a rule about foundry's
  // pipeline imposed on a fact about the book.
  const book = containerFromMembers(members);
  const view = viewPackage(book.opfPath, book.opfSource);

  // ── what each setter becomes ───────────────────────────────────────────────

  const edits: { start: number; end: number; text: string }[] = [];
  const changes: MetaChange[] = [];
  const unchanged: EpubMetaField[] = [];
  /** Elements this run rewrote, so refinements pointing at them can be named. */
  const touched = new Map<XmlElement, EpubMetaField>();

  for (const field of wanted) {
    const value = set[field]!;
    const existing = view.byField.get(field)!;

    /*
     * TWO OF THE SAME FIELD IS LEGAL EPUB AND IS REFUSED HERE. A book with two
     * `dc:creator` elements has two authors, and `--creator "X"` says nothing
     * about which of them is being corrected. Rewriting the first would look
     * like it worked and would silently attribute one author's book to another;
     * rewriting both would merge two people into one. Neither is something a
     * flag can mean, so the run stops and says how many there are.
     */
    if (existing.length > 1 && field !== 'identifier') {
      throw new MetaError(
        `${book.opfPath} declares ${existing.length} <dc:${field}> elements, and --${field} says `
        + 'nothing about which of them to rewrite. foundry will not pick one: the wrong one '
        + 'corrected reads exactly like the right one corrected. Edit the package by hand, or '
        + 'remove the duplicate first.',
      );
    }

    /*
     * `dc:identifier` is the exception to the rule above and to the insertion
     * rule below, both for the same reason: the one that matters is NAMED by
     * the package rather than found by position, and a new one would carry no
     * id and so would not be the book's identifier however it was written.
     */
    const target = field === 'identifier'
      ? uniqueIdentifierElement(book.opfPath, view)
      : existing[0];

    if (target === undefined) {
      /*
       * THE FIELD IS NOT THERE, so one is built. This is the half that is
       * actually hard, and `insertionPoint` and `dcPrefix` are where all of it
       * lives — both read the answer off the file rather than assuming one.
       *
       * `dc:language` reaches here too, and that is a DELIBERATE divergence
       * from the precedent: a package with no `dc:language` is invalid EPUB and
       * `translate` refuses it outright rather than inventing one
       * (`languageRange` says so in as many words), because translate's job is
       * to state a language a book already declares somewhere. This command's
       * job is the opposite — creating a missing field is half of what it
       * exists for — so a missing `dc:language` is inserted like any other. The
       * divergence is only about policy: where the element EXISTS, the bytes
       * spliced below are the bytes `languageRange` names, so the two commands
       * can never write this field to two different places.
       */
      const prefix = dcPrefix(book.opfPath, view);
      const { at, indent } = insertionPoint(view);
      const element = `${prefix}${field}`;
      edits.push({
        start: at,
        end: at,
        text: `\n${indent}<${element}>${escapeText(value)}</${element}>`,
      });
      changes.push({ field, element, from: null, to: value, created: true });
      continue;
    }

    const was = textOf(view.source, target);
    if (was === value) {
      // Given the value it already holds. Nothing is spliced — not even the
      // same bytes back over themselves — so a dialog that saves without
      // editing anything leaves the file's mtime and its every byte alone.
      unchanged.push(field);
      continue;
    }

    /*
     * `dc:language` goes through `translate/book.ts`'s own range function, so
     * the two commands that write this field write it at the same offsets. It
     * is the same element `view` already located; asking twice costs one parse
     * of a small document and buys the guarantee that the precedent and this
     * file can never drift apart.
     */
    const range = field === 'language'
      ? languageRange(view.source)
      : { start: target.innerStart, end: target.innerEnd };

    edits.push({ start: range.start, end: range.end, text: escapeText(value) });
    changes.push({
      field,
      element: target.name,
      from: was,
      to: value,
      created: false,
    });
    touched.set(target, field);
  }

  // ── the refinements that now describe the old text ────────────────────────

  /*
   * Collected from the metadata as it was READ, because a refinement's subject
   * is an id and this run changes no ids. Only elements whose text actually
   * moved are considered: a refinement of a field nobody edited is not stale,
   * it is just a refinement.
   */
  const stale: StaleRefinement[] = [];
  for (const [el, field] of touched) {
    const id = el.attrs.get('id');
    if (id === undefined) continue;
    for (const child of elementChildren(view.metadata)) {
      if (localName(child.tag) !== 'meta') continue;
      if (child.attrs.get('refines') !== `#${id}`) continue;
      const property = child.attrs.get('property');
      if (property === undefined) continue;
      stale.push({ field, property, value: textOf(view.source, child) });
    }
  }

  // ── what lands on disk ────────────────────────────────────────────────────

  const opfSource = edits.length === 0 ? view.source : spliceAll(view.source, edits);
  const written = edits.length > 0;

  /*
   * The report is read off the package AFTER the splices, never assembled from
   * what the setters were told to write. It is the same walk that produced the
   * plan, so a value that did not land — an element the parse and the splice
   * disagreed about — would show up here as the old text rather than as the new
   * one, and `--json` would say so. A report built from the inputs could not.
   */
  const after = edits.length === 0 ? view : viewPackage(book.opfPath, opfSource);
  const metadata = {} as EpubMetadata;
  const counts = {} as Record<EpubMetaField, number>;
  for (const field of EPUB_META_FIELDS) {
    const elements = after.byField.get(field)!;
    counts[field] = elements.length;
    const chosen = field === 'identifier' && after.uniqueIdentifier !== null
      ? elements.find((el) => el.attrs.get('id') === after.uniqueIdentifier) ?? elements[0]
      : elements[0];
    metadata[field] = chosen === undefined ? null : textOf(after.source, chosen);
  }

  const report: EpubMetaReport = {
    outPath: inPlace ? opts.epubPath : (opts.outPath ?? opts.epubPath),
    inPlace,
    opfPath: book.opfPath,
    uniqueIdentifier: after.uniqueIdentifier,
    metadata,
    counts,
    changes,
    unchanged,
    stale,
    written,
  };

  if (!written) {
    // A read, or a save that changed nothing. Nothing is written at all — not
    // the OPF, and for the file form not a second copy of the book either.
    // Writing an identical 20 MB file to report that nothing changed would be
    // the most expensive no-op in the program.
    return report;
  }

  if (inPlace) {
    fs.writeFileSync(path.join(opts.epubPath, ...book.opfPath.split('/')), opfSource, 'utf8');
    opts.log(`epub-meta: ${book.opfPath} rewritten in ${opts.epubPath}`);
    return report;
  }

  /*
   * The file form, written exactly as `epub-final` and `epub-stamp` write one:
   * `mimetype` first and stored so a reader can identify the archive at byte
   * offset 30, and every member nobody edited carried through with the bytes,
   * method and checksum it arrived with. The ONLY entry that differs from the
   * input is the package document — the chapters are not re-encoded and the
   * plates are not recompressed, so a diff of the two files is exactly the
   * change that was ordered.
   */
  const ordered = [
    ...members.filter((m) => m.path === 'mimetype'),
    ...members.filter((m) => m.path !== 'mimetype'),
  ];
  const entries: ZipEntry[] = ordered.map((member): ZipEntry => {
    if (member.path === book.opfPath) return zipText(member.path, opfSource);
    return {
      path: member.path,
      data: member.raw,
      method: member.method === 8 ? 8 : 0,
      crc: member.crc,
      uncompressedSize: member.uncompressedSize,
    };
  });
  await Bun.write(opts.outPath!, writeZip(entries));
  opts.log(`epub-meta: ${entries.length} members written, ${book.opfPath} rewritten`);
  return report;
}
