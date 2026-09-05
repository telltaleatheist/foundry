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
 *  - EPUB 3's `<meta refines="#id" property="…">` elements point at metadata ids.
 *    An id here is only ever ADDED to an element that had none, never changed
 *    and never renumbered, so no refinement in the file can come to point
 *    somewhere else. The one way a refinement could be orphaned is by REMOVING
 *    its subject — which `--creator` and `--subtitle` now do — and every removal
 *    takes the refinements of the removed element with it and names each one in
 *    the report. A dangling `refines="#creator2"` is invalid EPUB and is exactly
 *    the kind of damage nobody would notice until a validator ran.
 *
 *    What a refinement that SURVIVES can become is stale: correct a `dc:creator`
 *    and its `file-as` still sorts the book under the old name. Those are counted
 *    and named rather than edited, because "Kershaw, Ian" is not derivable from
 *    "Ian Kershaw" in the general case and a guess written into a library sort
 *    key is worse than a stated one. `--creator-file-as` exists so the sort name
 *    can be STATED in the same breath as the name it sorts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { spliceAll } from '../translate/blocks.js';
import { containerFromMembers, languageRange } from '../translate/book.js';
import { readLanguage } from '../translate/languages.js';
import type { ZipMember } from '../translate/unzip.js';
import { FinalError, readEpubInput } from './final.js';
import { decodeEntities, elements, findElement, localName, parseXml, type XmlElement } from './xml.js';

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
 *
 * TWO FIELDS HAVE SINCE EARNED THE DECISION, and both earn it the same way — by
 * being able to say the WHOLE answer rather than a piece of one:
 *
 *  - `--creator` REPEATS, and the list it builds is the complete new set of
 *    `dc:creator` elements: `--creator "Ian Kershaw" --creator "Richard Evans"`
 *    means the book has exactly those two authors, in that order. That is not
 *    the half-obeyed instruction the `dc:subject` paragraph refuses. The refusal
 *    there is about a flag that can only state ONE value being pointed at a
 *    field that holds many, so that "set the subject" silently means "delete
 *    seven subjects"; a flag that states the entire list has no such gap between
 *    what it says and what it does. The honest multi-valued form is
 *    replace-the-set, and the report names every element that was removed to
 *    make the set true — which is the other half of the same rule. (`--subject`
 *    is still not offered, and could be offered on exactly these terms if
 *    anybody wanted it.)
 *  - `--subtitle` is a SECOND `dc:title` distinguished from the first by an
 *    EPUB 3 `title-type` refinement, which is the only thing a subtitle is. It
 *    is not a Dublin Core element of its own — there is no `dc:subtitle` — so it
 *    is not in the list below; it is in `EPUB_META_REFINED` instead, and the
 *    difference is real rather than bookkeeping: writing it means writing an
 *    element AND the `<meta>` that says what the element is for.
 */
export const EPUB_META_FIELDS = ['title', 'creator', 'language', 'publisher', 'date', 'identifier'] as const;

export type EpubMetaField = (typeof EPUB_META_FIELDS)[number];

/**
 * The things this command writes that are not a Dublin Core element of their
 * own: a refinement, or an element that only means what it means because a
 * refinement says so.
 *
 * Kept apart from `EPUB_META_FIELDS` because every generic rule in this file —
 * "one element per field", "insert after the last DC element", "the value is the
 * element's text" — is a rule about a DC element and none of them is true of
 * these. A `subtitle` folded into the list above would be a `<dc:subtitle>`,
 * which is not a thing.
 */
export const EPUB_META_REFINED = ['subtitle', 'creator-file-as'] as const;

/** Anything this run can report a change to: a DC element, or one of the refined things above. */
export type EpubMetaSubject = EpubMetaField | (typeof EPUB_META_REFINED)[number];

/** The namespace `dc:` is bound to in every EPUB ever published. */
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';

/** The OPF's own namespace — where EPUB 2's `opf:file-as` attribute comes from. */
const OPF_NAMESPACE = 'http://www.idpf.org/2007/opf';

/** One author, as the package states them. */
export interface EpubCreator {
  /** The display name — the `dc:creator`'s text, as the book itself gives it. */
  name: string;
  /** The sort name: an EPUB 3 `file-as` refinement or an EPUB 2 `opf:file-as` attribute. Null when neither is there. */
  fileAs: string | null;
}

/**
 * What the package says now. `null` is "the package declares none", which is a
 * legal answer for four of the six.
 *
 * `title` is the MAIN title specifically, and `subtitle` is beside it rather
 * than glued onto it: a package that carries both carries two `dc:title`
 * elements, and a dialog that showed "Der Staat: Eine Geschichte" in one box
 * would write that whole string back as the main title the moment anybody
 * saved. `creator` is the FIRST author and stays what it always was, so a caller
 * that only ever wanted a name still reads one; `creators` is all of them.
 */
export type EpubMetadata = Record<EpubMetaField, string | null> & {
  /** The `dc:title` refined as `title-type: subtitle`, or null. */
  subtitle: string | null;
  /** Every `dc:creator` in document order, with the sort name each one carries. */
  creators: EpubCreator[];
};

/**
 * A refinement whose subject this run changed, so the refinement now describes
 * text that is no longer there.
 *
 * Reported, never edited. See this file's header.
 */
export interface StaleRefinement {
  /** What the refined element is about. */
  field: EpubMetaSubject;
  /** Which element of a repeated field, 1-based. Null when the field has only one. */
  ordinal: number | null;
  /** The `property` the refinement states, e.g. `file-as`, `alternate-script`. */
  property: string;
  /** What the refinement says, unchanged by this run. */
  value: string;
}

export interface MetaChange {
  field: EpubMetaSubject;
  /** The element as it is spelled in this file, e.g. `dc:publisher`. */
  element: string;
  /** Which element of a repeated field, 1-based. Null for the single-valued fields. */
  ordinal: number | null;
  /** What it said. `null` when the field was created. */
  from: string | null;
  to: string;
  /** True when no element existed and one was written into `<metadata>`. */
  created: boolean;
}

/**
 * An element this run took OUT of `<metadata>`.
 *
 * A category of its own rather than a `MetaChange` with an empty `to`, because
 * it is a different event and the difference is the whole point of the report:
 * a corrected field had a wrong answer in it, a created field had none, and a
 * removed one had an answer that this run decided the book should no longer
 * make. Every removal carries the sentence that justifies it, because a person
 * reading the run needs to know why an author left the book.
 */
export interface MetaRemoval {
  /** What the removed element was about. */
  field: EpubMetaSubject;
  /** The element as it was spelled, e.g. `dc:creator` or `meta property="role"`. */
  element: string;
  /** What it said. */
  was: string;
  /** Why it went, in one sentence already worded for a person. */
  why: string;
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
  /** `<package version>`, verbatim. "2.0" is what makes `--subtitle` a refusal and `opf:file-as` the spelling. */
  packageVersion: string | null;
  /** The metadata as it stands AFTER any writes — what `--json` prints. */
  metadata: EpubMetadata;
  /**
   * How many elements each field has, AFTER any writes. `title` counts every
   * `dc:title` including a subtitle, because that is what the package declares —
   * two titles is what a subtitled book looks like on disk.
   */
  counts: Record<EpubMetaField, number>;
  /** Field by field, old → new. Empty when the run only read. */
  changes: MetaChange[];
  /** Elements taken out of `<metadata>`, each with the reason. */
  removed: MetaRemoval[];
  /** Fields given a value they already held, so nothing was spliced for them. */
  unchanged: EpubMetaSubject[];
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

// ── the refinements, which are how EPUB 3 says everything it cannot say twice ─

/** Every `<meta refines="#id">` in `<metadata>`, in document order. */
function refinementsOf(view: PackageView, id: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of elementChildren(view.metadata)) {
    if (localName(child.tag) !== 'meta') continue;
    if (child.attrs.get('refines') === `#${id}`) out.push(child);
  }
  return out;
}

/** The one refinement of `el` stating `property`, or undefined. An element with no id has none by definition. */
function refinement(view: PackageView, el: XmlElement, property: string): XmlElement | undefined {
  const id = el.attrs.get('id');
  if (id === undefined) return undefined;
  return refinementsOf(view, id).find((m) => m.attrs.get('property') === property);
}

/**
 * The refinements that RESTATE their subject's text, and so stop being true the
 * moment the text is corrected.
 *
 * The distinction matters because the alternative is a report that cries wolf.
 * `file-as` is "Kershaw, Ian" for "Ian Kershaw" and describes nothing else once
 * the name changes; `alternate-script` is the same name in another script and is
 * just as dead. `role`, `title-type`, `display-seq` and `identifier-type`
 * describe what the element IS or where it sits, and a corrected spelling leaves
 * every one of them exactly as true as it was — an author is still the author,
 * a main title is still the main title. Naming those as stale would train a
 * reader to ignore the line that matters.
 */
const RESTATING_PROPERTIES: ReadonlySet<string> = new Set(['file-as', 'alternate-script']);

/**
 * Which `dc:title` is the book's name and which is its subtitle.
 *
 * EPUB 3 gives a package as many `dc:title` elements as it likes and tells them
 * apart with `<meta property="title-type">` — `main`, `subtitle`, `collection`,
 * `edition`, `short`, `extended`. So "the title" is a question with an answer in
 * the file rather than a position: the main title is the one refined `main`; a
 * package that refines nothing has its title first, which is what the
 * specification says to assume and what every such package means; and where
 * every title is typed but none is `main`, the first that is not the subtitle is
 * the closest thing to an answer there is.
 *
 * `typed` is the fact `--title` needs: two `dc:title` elements that NOTHING
 * distinguishes are two titles and a flag cannot mean either of them, but two
 * that a refinement distinguishes are a title and a subtitle and `--title`
 * means the first without ambiguity.
 */
interface TitleRoles {
  main: XmlElement | undefined;
  subtitle: XmlElement | undefined;
  /** True when at least one `dc:title` carries a `title-type` refinement. */
  typed: boolean;
}

function titleRoles(view: PackageView): TitleRoles {
  const titles = view.byField.get('title')!;
  const types = titles.map((el) => {
    const meta = refinement(view, el, 'title-type');
    return meta === undefined ? null : textOf(view.source, meta);
  });
  const pick = (want: (t: string | null) => boolean): XmlElement | undefined => {
    const at = types.findIndex(want);
    return at < 0 ? undefined : titles[at];
  };
  return {
    main: pick((t) => t === 'main') ?? pick((t) => t === null) ?? pick((t) => t !== 'subtitle'),
    subtitle: pick((t) => t === 'subtitle'),
    typed: types.some((t) => t !== null),
  };
}

/**
 * The sort name a `dc:creator` carries, whichever of the two conventions the
 * package uses.
 *
 * Both are read on the way OUT even though only one is ever written on the way
 * in: an EPUB 2 that has been through an EPUB 3 conversion carries both
 * spellings often enough, and a dialog that showed no sort name for a book that
 * plainly has one would be reading the file wrong rather than reporting it.
 */
function fileAsOf(view: PackageView, el: XmlElement): string | null {
  for (const [name, value] of el.attrs) {
    if (localName(name) === 'file-as') return value;
  }
  const meta = refinement(view, el, 'file-as');
  return meta === undefined ? null : textOf(view.source, meta);
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
/**
 * Put one EPUB-2 `<meta name … content …/>` into a package's `<metadata>`,
 * replacing whatever was there under that name.
 *
 * ── WHY THIS LIVES HERE AND NOT WHERE ITS ONE CALLER IS ─────────────────────
 *
 * The caller is `clean-text`'s stamp, on its way into a book being written
 * (`--narration-stamp`, src/vlm/epub.ts). But what it needs is not a fact about
 * narration, it is the answer to *"how does this program put an element into an
 * OPF?"* — and that answer is this file's, argued at length in its header: by
 * SOURCE-OFFSET SPLICE, never by re-serialising. Rebuilding a package from
 * parsed values would regenerate the manifest, the spine, the refinements and
 * the rendition properties out of foundry's idea of them, and everything the
 * original carried that foundry has no field for would silently vanish. A
 * second implementation of the same splice, living beside the one caller that
 * happens to need it today, is how that rule gets forgotten by the third.
 *
 * ── EPUB 2's `name`/`content` FORM, DELIBERATELY ────────────────────────────
 *
 * It needs no `prefix` declaration on `<package>`, every reader and every
 * validator ignores an unknown `name`, and both EPUB versions this project
 * writes carry it unchanged. That is BookForge's choice and this is the same
 * seam, so it is not re-litigated here.
 *
 * ── REPLACED, NEVER JOINED ──────────────────────────────────────────────────
 *
 * Two `<meta>` under one name would be two claims about one file, and nothing
 * downstream has a rule for which of them wins. So every existing one is
 * removed and one is written. They are removed with `removalRange`, so a
 * package does not gain a blank line each time it is re-stamped, and the
 * removals and the insertion go through `spliceAll` together — which refuses an
 * overlap rather than letting two edits disagree about what the file will look
 * like.
 *
 * The insertion point is `metaInsertionPoint`'s: after the LAST thing in
 * `<metadata>`, which keeps the `<meta>` block together at the end the way
 * every package a person has ever opened is laid out.
 */
export function insertPackageMeta(
  opfPath: string,
  source: string,
  name: string,
  content: string,
): string {
  const view = viewPackage(opfPath, source);

  const doomed = elementChildren(view.metadata).filter(
    (child) => localName(child.tag) === 'meta' && child.attrs.get('name') === name,
  );
  const where = metaInsertionPoint(view, new Set(doomed));
  const edits = doomed.map((el) => removalRange(source, el));
  edits.push({
    start: where.at,
    end: where.at,
    text: `\n${where.indent}<meta name="${escapeAttr(name)}" content="${escapeAttr(content)}"/>`,
  });
  return spliceAll(source, edits);
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The same, for a value that is going inside double quotes. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * The source range of one attribute's VALUE, quotes excluded, or null when the
 * start tag does not carry it.
 *
 * The parser hands back attributes as decoded strings and not as spans, because
 * every other stage only ever reads them. Writing one is this command's problem
 * alone, and the answer is found by re-scanning the element's own start tag —
 * `[start, innerStart)` is exactly `<dc:creator …>` and nothing else — so the
 * splice lands inside the quotes of the attribute named and cannot touch the
 * element's text, its other attributes or its neighbours.
 */
function attrValueRange(source: string, el: XmlElement, name: string): { start: number; end: number } | null {
  const tag = source.slice(el.start, el.innerStart);
  const found = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(["'])`, 'i').exec(tag);
  if (found === null) return null;
  const open = found.index + found[0].length;
  const close = tag.indexOf(found[1]!, open);
  if (close < 0) return null;
  return { start: el.start + open, end: el.start + close };
}

/** Where an attribute may always be added: immediately after the element's name. */
function attrInsertPoint(el: XmlElement): number {
  return el.start + 1 + el.name.length;
}

/**
 * Every `id` in the whole package, so a minted one collides with nothing.
 *
 * The WHOLE package and not just `<metadata>`: `id` is document-unique in XML,
 * the manifest is full of them, and an `id="title"` that a manifest item already
 * claimed would make the package invalid in a way that only a validator would
 * ever mention.
 */
function takenIds(view: PackageView): Set<string> {
  const out = new Set<string>();
  for (const el of elements(view.pkg)) {
    const id = el.attrs.get('id');
    if (id !== undefined) out.add(id);
  }
  return out;
}

function freshId(taken: Set<string>, base: string): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * The range that takes an element out WITHOUT leaving its line behind.
 *
 * An element removal that cut only `<dc:creator>…</dc:creator>` would leave the
 * indentation that opened its line and the newline that ended it, so a package
 * that lost one author would gain a blank line for every author it lost. Where
 * the element does not open its own line — a package with no line breaks in it —
 * only the element goes, because there is no line to take.
 */
function removalRange(source: string, el: XmlElement): { start: number; end: number; text: string } {
  const indent = ownLineIndent(source, el.start);
  if (indent === null) return { start: el.start, end: el.end, text: '' };
  const lineStart = el.start - indent.length;
  return { start: lineStart > 0 ? lineStart - 1 : lineStart, end: el.end, text: '' };
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

/**
 * Where a new `<meta>` refinement goes: after the LAST thing in `<metadata>`.
 *
 * The mirror of `insertionPoint`'s argument, and the same argument. That
 * function keeps the Dublin Core block contiguous by putting a new DC element
 * after the last DC element; this one keeps the refinements together at the end
 * by putting a new refinement after everything. A `<meta refines>` wedged
 * between two `dc:` elements is legal and reads like a mistake, and the two
 * halves of `<metadata>` are how every package a person has ever opened is laid
 * out.
 *
 * `doomed` is skipped because this run may be removing the very element the
 * anchor would otherwise be: an insertion point inside a range being cut is an
 * overlapping splice, which `spliceAll` refuses — correctly, since it would mean
 * this function and the removal disagree about what the file will look like.
 */
function metaInsertionPoint(view: PackageView, doomed: ReadonlySet<XmlElement>): { at: number; indent: string } {
  const surviving = elementChildren(view.metadata).filter((c) => !doomed.has(c));
  const last = surviving[surviving.length - 1];
  if (last === undefined) return insertionPoint(view);
  const indent = ownLineIndent(view.source, last.start);
  if (indent !== null) return { at: last.end, indent };
  return { at: last.end, indent: `${ownLineIndent(view.source, view.metadata.start) ?? ''}  ` };
}

/**
 * How this package spells a sort name — and it is the PACKAGE's answer, not
 * foundry's.
 *
 * EPUB 2 puts the sort name in an attribute, `<dc:creator opf:file-as="Kershaw,
 * Ian">`; EPUB 3 replaced that with a refinement, `<meta refines="#id"
 * property="file-as">`. Writing the wrong one is not an error anything reports:
 * an EPUB 3 reader ignores the attribute, an EPUB 2 reader ignores the
 * refinement, and either way the book sorts under the author's first name in
 * somebody's library and nobody ever learns why. So the convention is read off
 * the file — first from a `file-as` the metadata already carries, which settles
 * it outright, then from `<package version>`.
 *
 * The refusal is the EPUB 2 package that binds the OPF namespace to no prefix
 * its metadata could use. The attribute is the only spelling such a package
 * understands, and it cannot be written without adding a namespace declaration
 * to a start tag this command did not write — which is a bigger edit than a
 * metadata correction gets to make, and one whose failure mode is a package that
 * no longer parses.
 */
function fileAsAttribute(opfPath: string, view: PackageView): string | null {
  for (const child of elementChildren(view.metadata)) {
    for (const [name] of child.attrs) {
      if (localName(name) === 'file-as' && name.includes(':')) return name;
    }
  }
  const version = view.pkg.attrs.get('version') ?? '';
  if (!version.startsWith('2')) return null;

  for (const el of [view.metadata, view.pkg]) {
    for (const [name, value] of el.attrs) {
      if (value === OPF_NAMESPACE && name.startsWith('xmlns:')) return `${name.slice(6)}:file-as`;
    }
  }
  throw new MetaError(
    `${opfPath} is an EPUB ${version} package, where a sort name is written as an opf:file-as `
    + `attribute — and it binds the OPF namespace (${OPF_NAMESPACE}) to no prefix foundry can see. `
    + 'Writing the EPUB 3 refinement instead would put a <meta> in it that no EPUB 2 reader looks '
    + 'at, and adding a namespace declaration to <package> is a bigger edit than a metadata '
    + 'correction gets to make. Leave --creator-file-as off, or declare xmlns:opf on <metadata>.',
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The run
// ═════════════════════════════════════════════════════════════════════════════

export interface EpubMetaOptions {
  /** An EPUB file, or the directory one was unpacked into. */
  epubPath: string;
  /** Where the edited book is written. Required for a FILE that is being written; refused for a directory. */
  outPath?: string | undefined;
  /**
   * The fields to set. A field absent here is not touched, not read back and not
   * renormalised.
   *
   * `creator` is still accepted here and means exactly `creators: [value]`, so a
   * caller written before the list existed keeps working unchanged. Passing both
   * is a defect and is refused.
   */
  set?: Partial<Record<EpubMetaField, string>> | undefined;
  /**
   * The COMPLETE new set of `dc:creator` elements, in order. Undefined or empty
   * leaves the book's authors alone; anything else replaces all of them.
   */
  creators?: readonly string[] | undefined;
  /**
   * Sort names for the creators above, paired BY POSITION. Shorter than the
   * creator list is allowed — the tail simply gets none. Longer is refused,
   * because a sort name with no name to sort is not a fact about the book.
   */
  creatorFileAs?: readonly string[] | undefined;
  /**
   * The subtitle. Undefined leaves it alone; a blank string REMOVES it, which is
   * the one blank this command accepts and the only way to say "this book has no
   * subtitle after all".
   */
  subtitle?: string | undefined;
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

  /*
   * THE AUTHORS ARRIVE IN TWO SHAPES AND MEAN ONE THING. `set.creator` is the
   * single-valued form every caller used before the list existed, and it is
   * exactly `creators: [value]` — one name, which is a complete set of one. Both
   * at once is a caller contradicting itself rather than a book being wrong, so
   * it is refused as the defect it is rather than resolved by precedence.
   */
  if (opts.creators !== undefined && opts.creators.length > 0 && set.creator !== undefined) {
    throw new MetaError(
      'epubMeta was given both set.creator and creators, which are two statements of the same '
      + 'field. Pass one: creators is the complete list, and set.creator is the one-name spelling '
      + 'of it.',
    );
  }
  const creators: string[] | null = opts.creators !== undefined && opts.creators.length > 0
    ? [...opts.creators]
    : set.creator !== undefined ? [set.creator] : null;
  const creatorFileAs = [...(opts.creatorFileAs ?? [])];
  const subtitle = opts.subtitle;

  /** The single-valued Dublin Core setters. `creator` is not one of them any more. */
  const wanted = EPUB_META_FIELDS.filter((f) => f !== 'creator' && set[f] !== undefined);
  /** True when this run has been asked to change anything at all — which is what `--out` is about. */
  const asked = wanted.length > 0 || creators !== null || subtitle !== undefined;

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

  /*
   * THE SAME RULE FOR THE LIST, STATED PER ENTRY. `--creator "" --creator "Ian
   * Kershaw"` is not a one-author book with a stray flag; it is a list whose
   * first author has no name, and shortening it silently would renumber every
   * `--creator-file-as` after it.
   */
  for (const name of creators ?? []) {
    if (name.trim() === '') {
      throw new MetaError(
        '--creator was given an empty value. Every --creator is one author of the book, and an '
        + 'author whose name is nothing is not one. Leave the flag out and the book keeps the '
        + 'authors it has.',
      );
    }
  }
  for (const sortName of creatorFileAs) {
    if (sortName.trim() === '') {
      throw new MetaError(
        '--creator-file-as was given an empty value. A sort name that is blank sorts the book '
        + 'before every other book in a library and says nothing about why. Leave it out for that '
        + 'author and none is written.',
      );
    }
  }
  /*
   * MORE SORT NAMES THAN AUTHORS IS A REFUSAL BY NAME, and fewer is not. The
   * flags pair up in the order they were given, so a trailing
   * `--creator-file-as` belongs to an author who was never named — the list was
   * meant to have another `--creator` in it and does not, and writing the sort
   * names that DO pair while dropping one on the floor is the half-obeyed
   * instruction this program refuses. A short list is different in kind: it says
   * nothing about the authors it does not reach, which is a thing a person means
   * often (one author whose name sorts strangely, three who do not).
   */
  if (creators !== null && creatorFileAs.length > creators.length) {
    throw new MetaError(
      `${creatorFileAs.length} --creator-file-as values were given for ${creators.length} `
      + '--creator value(s). They pair up in the order they are written, so the last '
      + `${creatorFileAs.length - creators.length} sort name(s) — "${creatorFileAs.slice(creators.length).join('", "')}" `
      + '— belong to an author nobody named. Add the missing --creator, or drop the extra sort name.',
    );
  }
  if (creators === null && creatorFileAs.length > 0) {
    throw new MetaError(
      '--creator-file-as says how one of --creator\'s authors sorts, and no --creator was given. '
      + 'On its own it names no author: the flags pair up by position, and there are no positions. '
      + 'Pass the authors too — the list replaces the ones the book carries.',
    );
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
  if (!inPlace && asked && (opts.outPath === undefined || opts.outPath === '')) {
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
  const removed: MetaRemoval[] = [];
  const unchanged: EpubMetaSubject[] = [];
  /** Elements this run rewrote, so refinements pointing at them can be named. */
  const touched = new Map<XmlElement, { field: EpubMetaSubject; ordinal: number | null }>();
  /** Elements this run is CUTTING, so nothing anchors an insertion inside one. */
  const doomed = new Set<XmlElement>();
  /** Refinements this run rewrote itself, so they are not then reported as stale. */
  const refreshed = new Set<XmlElement>();
  /** Every id in the package, so a minted one collides with nothing. */
  const taken = takenIds(view);
  /** Ids this run has minted, by the element each was minted for. */
  const minted = new Map<XmlElement, string>();
  /** New `<meta>` refinements, in the order they were planned. All land together at the end of `<metadata>`. */
  const newRefinements: string[] = [];
  /** New Dublin Core elements, keyed by the offset they are inserted at, so two of them at one anchor stay one splice. */
  const newElements = new Map<number, string>();

  const roles = titleRoles(view);
  /** A Dublin Core element name spelled the way THIS package spells one. Refuses a package that binds no prefix. */
  const dcTag = (name: string): string => `${dcPrefix(book.opfPath, view)}${name}`;

  const appendElement = (at: number, text: string): void => {
    newElements.set(at, (newElements.get(at) ?? '') + text);
  };

  /**
   * The id of an element, MINTED AND SPLICED INTO ITS START TAG if it has none.
   *
   * The one place this command writes an id, and it only ever ADDS one to an
   * element that carried none — so nothing in the file can already be pointing
   * at it, and no refinement anywhere changes what it refines. An element that
   * has an id keeps it, because that id is what everything else in the package
   * knows the element by.
   */
  const idOf = (el: XmlElement, base: string): string => {
    const had = el.attrs.get('id');
    if (had !== undefined) return had;
    const already = minted.get(el);
    if (already !== undefined) return already;
    const id = freshId(taken, base);
    minted.set(el, id);
    const at = attrInsertPoint(el);
    edits.push({ start: at, end: at, text: ` id="${escapeAttr(id)}"` });
    return id;
  };

  /** Cut an element out, and cut everything that refines it out with it. */
  const remove = (el: XmlElement, field: EpubMetaSubject, why: string): void => {
    doomed.add(el);
    edits.push(removalRange(view.source, el));
    removed.push({ field, element: el.name, was: textOf(view.source, el), why });
    const id = el.attrs.get('id');
    if (id === undefined) return;
    for (const meta of refinementsOf(view, id)) {
      doomed.add(meta);
      edits.push(removalRange(view.source, meta));
      removed.push({
        field,
        element: `meta property="${meta.attrs.get('property') ?? '?'}"`,
        was: textOf(view.source, meta),
        why: `it refined <${el.name} id="${id}">, which this run removed, and a <meta refines="#${id}"> `
          + 'pointing at nothing is invalid EPUB',
      });
    }
  };

  /*
   * THE SUBTITLE IS DECIDED BEFORE THE TITLE IS WRITTEN. A title this run
   * CREATES has to be born with an id when a subtitle is coming, because a
   * subtitle is a second `dc:title` and the only thing that makes the first one
   * the main title is a refinement pointing at its id.
   */
  const writingSubtitle = subtitle !== undefined && subtitle.trim() !== '';
  let createdTitleId: string | null = null;

  /*
   * A SUBTITLE IS AN EPUB 3 IDEA AND IS REFUSED TO AN EPUB 2 PACKAGE. There is
   * no `title-type` in EPUB 2 — no refinements at all — so a second `dc:title`
   * in a 2.0 package is simply a second title, which every EPUB 2 reader will
   * either ignore or show instead of the first. Writing one would be foundry
   * saying "subtitle" into a file that has no way to hear the word, and the book
   * would come back from the dialog looking edited and be wrong. The refusal
   * says what the package is, so the app can stop offering the field for it.
   */
  const packageVersion = view.pkg.attrs.get('version') ?? null;
  if (writingSubtitle && packageVersion !== null && packageVersion.startsWith('2')) {
    throw new MetaError(
      `${book.opfPath} is an EPUB ${packageVersion} package, and a subtitle is an EPUB 3 refinement `
      + '(<meta property="title-type">subtitle</meta>) that EPUB 2 has no equivalent of. A second '
      + 'dc:title written here would be a second TITLE to every reader that opens it. Put the '
      + 'subtitle in --title if the edition really states it that way, or convert the book first.',
    );
  }

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
    if (existing.length > 1 && field !== 'identifier' && !(field === 'title' && roles.typed)) {
      throw new MetaError(
        `${book.opfPath} declares ${existing.length} <dc:${field}> elements, and --${field} says `
        + 'nothing about which of them to rewrite. foundry will not pick one: the wrong one '
        + 'corrected reads exactly like the right one corrected. Edit the package by hand, or '
        + 'remove the duplicate first.',
      );
    }

    /*
     * TWO EXCEPTIONS TO THE RULE ABOVE, and both are exceptions because the
     * package itself says which element is meant rather than leaving it to
     * position:
     *
     *  - `dc:identifier`: the one that matters is NAMED by `<package
     *    unique-identifier>`. It is also the exception to the insertion rule
     *    below, for the same reason — a new one would carry no id and so would
     *    not be the book's identifier however it was written.
     *  - `dc:title`: a package with a subtitle has two, and `title-type`
     *    refinements say which is which (`titleRoles`). `--title` means the MAIN
     *    title, exactly as a person reading the dialog means it, and the
     *    ambiguity the refusal above is about does not exist here. Where nothing
     *    distinguishes two titles the refusal still stands.
     */
    const target = field === 'identifier'
      ? uniqueIdentifierElement(book.opfPath, view)
      : field === 'title'
        ? roles.main
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
      const { at, indent } = insertionPoint(view);
      const element = dcTag(field);
      /*
       * A CREATED TITLE IS BORN WITH AN ID when a subtitle is coming, because
       * the subtitle's whole meaning is a refinement pointing at the main title
       * and there is nothing to point at otherwise. Every other created element
       * carries no id at all — an id is a name for other elements to use, and
       * inventing one nothing refers to is clutter in somebody's package.
       */
      const id = field === 'title' && writingSubtitle ? freshId(taken, 'title-main') : null;
      if (id !== null) createdTitleId = id;
      appendElement(
        at,
        `\n${indent}<${element}${id === null ? '' : ` id="${escapeAttr(id)}"`}>`
        + `${escapeText(value)}</${element}>`,
      );
      changes.push({ field, element, ordinal: null, from: null, to: value, created: true });
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
      ordinal: null,
      from: was,
      to: value,
      created: false,
    });
    touched.set(target, { field, ordinal: null });
  }

  // ── the subtitle: a second title, and the refinement that explains it ──────

  /*
   * A SUBTITLE IS NOT A SECOND HALF OF THE TITLE. "Der Staat: Eine Geschichte"
   * in one `dc:title` is what a cataloguer types when the format gives them
   * nowhere else to put it, and every reading system then shows the whole string
   * as the book's name, sorts by it, and reads it aloud. EPUB 3 has the answer:
   * two `dc:title` elements, each refined with the `title-type` that says what
   * it is. So this writes two elements and a `<meta>`, and REPLACES rather than
   * appends — a book has one subtitle, and a second `--subtitle` correcting the
   * first would otherwise leave the first one there.
   *
   * THE MAIN TITLE GAINS `title-type: main` WHENEVER A SUBTITLE IS PRESENT, even
   * though the specification says the first `dc:title` is the main title by
   * default. The default is a rule about a package with ONE title; a package
   * with two and only one of them typed leaves every reading system to decide
   * which of the untyped ones it is looking at, and reading systems decide
   * differently. Saying it costs one line and removes the guess.
   */
  if (subtitle !== undefined) {
    const existingSubtitle = roles.subtitle;

    if (writingSubtitle) {
      if (roles.main === undefined && createdTitleId === null) {
        throw new MetaError(
          `${book.opfPath} declares no dc:title at all, and a subtitle refines one — it is the `
          + 'SECOND title of a book, and this package states no first. Pass --title in the same run '
          + 'and both are written together; a lone subtitle would be a book whose only stated name '
          + 'is the part that comes after the colon.',
        );
      }

      if (existingSubtitle === undefined) {
        /*
         * Built beside the main title rather than at the end of the Dublin Core
         * block, because the two elements are one statement and a `dc:language`
         * between them reads as an accident. The indentation is the main title's
         * own, for `insertionPoint`'s reason.
         */
        const anchor = roles.main;
        const fallback = insertionPoint(view);
        const at = anchor === undefined ? fallback.at : anchor.end;
        const indent = anchor === undefined
          ? fallback.indent
          : ownLineIndent(view.source, anchor.start) ?? fallback.indent;
        const element = dcTag('title');
        const id = freshId(taken, 'title-subtitle');
        appendElement(at, `\n${indent}<${element} id="${escapeAttr(id)}">${escapeText(subtitle)}</${element}>`);
        newRefinements.push(`<meta refines="#${escapeAttr(id)}" property="title-type">subtitle</meta>`);
        changes.push({ field: 'subtitle', element, ordinal: null, from: null, to: subtitle, created: true });
      } else {
        const was = textOf(view.source, existingSubtitle);
        if (was === subtitle) {
          unchanged.push('subtitle');
        } else {
          edits.push({ start: existingSubtitle.innerStart, end: existingSubtitle.innerEnd, text: escapeText(subtitle) });
          changes.push({
            field: 'subtitle',
            element: existingSubtitle.name,
            ordinal: null,
            from: was,
            to: subtitle,
            created: false,
          });
          touched.set(existingSubtitle, { field: 'subtitle', ordinal: null });
        }
      }

      // The main title says it is the main title, once the book has two.
      if (roles.main === undefined) {
        newRefinements.push(`<meta refines="#${escapeAttr(createdTitleId!)}" property="title-type">main</meta>`);
      } else if (refinement(view, roles.main, 'title-type') === undefined) {
        const mainId = idOf(roles.main, 'title-main');
        newRefinements.push(`<meta refines="#${escapeAttr(mainId)}" property="title-type">main</meta>`);
      }
    } else if (existingSubtitle === undefined) {
      // Asked to have no subtitle, and it has none. Nothing is spliced.
      unchanged.push('subtitle');
    } else {
      /*
       * REMOVAL TAKES THE WHOLE STATEMENT, not the element it happens to live
       * in. The `dc:title` goes, every `<meta refines>` that pointed at it goes
       * with it (`remove`), and the `title-type: main` on the surviving title
       * goes too WHEN IT IS THE ONLY TITLE LEFT — because `main` exists to
       * distinguish one title from another, and a package with one title has
       * nothing to distinguish it from. Left behind, it is the fossil of a
       * subtitle that no longer exists. Where the package still has other
       * titles — an edition, a collection — it is doing real work and stays.
       */
      remove(
        existingSubtitle,
        'subtitle',
        'an empty --subtitle says the book has none, so the second dc:title and everything '
        + 'refining it came out',
      );
      const survivors = view.byField.get('title')!.filter((el) => el !== existingSubtitle);
      const soleTitle = survivors.length === 1 ? survivors[0]! : undefined;
      const mainMeta = soleTitle === undefined ? undefined : refinement(view, soleTitle, 'title-type');
      if (mainMeta !== undefined && !doomed.has(mainMeta) && textOf(view.source, mainMeta) === 'main') {
        doomed.add(mainMeta);
        edits.push(removalRange(view.source, mainMeta));
        removed.push({
          field: 'title',
          element: 'meta property="title-type"',
          was: 'main',
          why: `<${soleTitle!.name}> is now the only title in the package, and "main" exists to tell `
            + 'one title from another',
        });
      }
    }
  }

  // ── the authors, as a set ─────────────────────────────────────────────────

  if (creators !== null) {
    const existing = view.byField.get('creator')!;

    /*
     * ONE NAME AGAINST ONE ELEMENT IS THE OLD COMMAND, UNCHANGED. `--creator
     * "Ian Kershaw"` on a book with one author corrects that author's name by
     * splicing the element's TEXT — the start tag, its id, its `opf:role="aut"`
     * and every refinement pointing at it survive untouched, exactly as they did
     * before this flag could repeat, and a `file-as` that now sorts under the old
     * name is REPORTED rather than guessed at. That is the entire behaviour of
     * the single-creator flag, and it is preserved by construction rather than by
     * a promise: this branch is the code that always ran.
     *
     * Everything else goes through the set path below, and the reason is that
     * every other case is a statement about the LIST — two names, or a name with
     * the sort key stated beside it, or one name aimed at a book that declares
     * two authors. A list can only be written by making the file's list equal it.
     */
    const correcting = creators.length === 1 && creatorFileAs.length === 0 && existing.length <= 1;
    const element = dcTag('creator');

    if (correcting) {
      const name = creators[0]!;
      const target = existing[0];
      if (target === undefined) {
        const { at, indent } = insertionPoint(view);
        appendElement(at, `\n${indent}<${element}>${escapeText(name)}</${element}>`);
        changes.push({ field: 'creator', element, ordinal: null, from: null, to: name, created: true });
      } else {
        const was = textOf(view.source, target);
        if (was === name) {
          unchanged.push('creator');
        } else {
          edits.push({ start: target.innerStart, end: target.innerEnd, text: escapeText(name) });
          changes.push({ field: 'creator', element: target.name, ordinal: null, from: was, to: name, created: false });
          touched.set(target, { field: 'creator', ordinal: null });
        }
      }
    } else {
      /*
       * THE SET PATH. The new list is matched to the elements already there BY
       * POSITION: the first author is written into the first `dc:creator`, and
       * so on down. That is not an optimisation — it is what keeps the promise
       * above true for every author it can. An element that is rewritten keeps
       * its start tag, so a publisher's `opf:role="aut"` and the ids its own
       * refinements point at survive a run that corrects two spellings, and a
       * `file-as` that has gone stale is named for exactly the same reason it
       * always was.
       *
       * Only the SURPLUS is removed — the authors the new list does not reach —
       * and each one takes its refinements with it and is named in the report
       * with the count that justified it. A book that comes back with one fewer
       * author says so in a sentence, which is the difference between replacing
       * a list and quietly truncating one.
       */
      const style = creatorFileAs.length > 0 ? fileAsAttribute(book.opfPath, view) : null;
      const fallback = insertionPoint(view);
      const last = existing[existing.length - 1];
      const at = last === undefined ? fallback.at : last.end;
      const indent = existing[0] === undefined
        ? fallback.indent
        : ownLineIndent(view.source, existing[0].start) ?? fallback.indent;

      /** The sort name for one creator, in whichever of the two spellings this package uses. */
      const planFileAs = (el: XmlElement, sortName: string, ordinal: number): void => {
        if (style !== null) {
          const range = attrValueRange(view.source, el, style);
          if (range === null) {
            const insert = attrInsertPoint(el);
            edits.push({ start: insert, end: insert, text: ` ${style}="${escapeAttr(sortName)}"` });
            changes.push({
              field: 'creator-file-as',
              element: `${el.name} ${style}`,
              ordinal,
              from: null,
              to: sortName,
              created: true,
            });
            return;
          }
          const had = decodeEntities(view.source.slice(range.start, range.end));
          if (had === sortName) {
            unchanged.push('creator-file-as');
            return;
          }
          edits.push({ start: range.start, end: range.end, text: escapeAttr(sortName) });
          changes.push({
            field: 'creator-file-as',
            element: `${el.name} ${style}`,
            ordinal,
            from: had,
            to: sortName,
            created: false,
          });
          return;
        }

        const meta = refinement(view, el, 'file-as');
        if (meta === undefined) {
          const id = idOf(el, `creator-${ordinal}`);
          newRefinements.push(
            `<meta refines="#${escapeAttr(id)}" property="file-as">${escapeText(sortName)}</meta>`,
          );
          changes.push({
            field: 'creator-file-as',
            element: 'meta property="file-as"',
            ordinal,
            from: null,
            to: sortName,
            created: true,
          });
          return;
        }
        // Rewritten by this run, so it is not stale — it is the sort name the
        // run was given, sitting where the package already kept one.
        refreshed.add(meta);
        const had = textOf(view.source, meta);
        if (had === sortName) {
          unchanged.push('creator-file-as');
          return;
        }
        edits.push({ start: meta.innerStart, end: meta.innerEnd, text: escapeText(sortName) });
        changes.push({
          field: 'creator-file-as',
          element: 'meta property="file-as"',
          ordinal,
          from: had,
          to: sortName,
          created: false,
        });
      };

      for (let i = 0; i < creators.length; i += 1) {
        const name = creators[i]!;
        const sortName = creatorFileAs[i];
        const ordinal = i + 1;
        const target = existing[i];

        if (target === undefined) {
          /*
           * An author the book did not have. Written with an id only when a sort
           * name needs one to point at — the same rule the created title obeys,
           * and for the same reason.
           */
          const id = sortName !== undefined && style === null ? freshId(taken, `creator-${ordinal}`) : null;
          const attrs = (id === null ? '' : ` id="${escapeAttr(id)}"`)
            + (sortName !== undefined && style !== null ? ` ${style}="${escapeAttr(sortName)}"` : '');
          appendElement(at, `\n${indent}<${element}${attrs}>${escapeText(name)}</${element}>`);
          changes.push({ field: 'creator', element, ordinal, from: null, to: name, created: true });
          if (sortName !== undefined) {
            if (id !== null) {
              newRefinements.push(
                `<meta refines="#${escapeAttr(id)}" property="file-as">${escapeText(sortName)}</meta>`,
              );
            }
            changes.push({
              field: 'creator-file-as',
              element: style === null ? 'meta property="file-as"' : `${element} ${style}`,
              ordinal,
              from: null,
              to: sortName,
              created: true,
            });
          }
          continue;
        }

        const was = textOf(view.source, target);
        if (was === name) {
          unchanged.push('creator');
        } else {
          edits.push({ start: target.innerStart, end: target.innerEnd, text: escapeText(name) });
          changes.push({ field: 'creator', element: target.name, ordinal, from: was, to: name, created: false });
          touched.set(target, { field: 'creator', ordinal });
        }
        if (sortName !== undefined) planFileAs(target, sortName, ordinal);
      }

      for (let i = creators.length; i < existing.length; i += 1) {
        remove(
          existing[i]!,
          'creator',
          `the run gave ${creators.length} --creator value(s), which is the complete new list of `
          + `this book's authors, and this was author ${i + 1}`,
        );
      }
    }
  }

  // ── the elements and refinements this run adds ────────────────────────────

  /*
   * Emitted here, at the end, and not where they were decided. Two creators
   * appended to the same book are one insertion at one offset rather than two at
   * the same offset, and every new `<meta>` lands together after the last thing
   * `<metadata>` still contains — which is only knowable once every removal is
   * known.
   */
  for (const [at, text] of newElements) edits.push({ start: at, end: at, text });
  if (newRefinements.length > 0) {
    const anchor = metaInsertionPoint(view, doomed);
    edits.push({
      start: anchor.at,
      end: anchor.at,
      text: newRefinements.map((meta) => `\n${anchor.indent}${meta}`).join(''),
    });
  }

  // ── the refinements that now describe the old text ────────────────────────

  /*
   * Collected from the metadata as it was READ, because a refinement's subject
   * is an id and this run never changes one. Only elements whose text actually
   * moved are considered: a refinement of a field nobody edited is not stale, it
   * is just a refinement.
   *
   * Three kinds are passed over, each for a reason of its own. A refinement this
   * run REWROTE is the answer, not a leftover. One that went out with its
   * element is not stale, it is gone. And one whose property does not restate
   * its subject's text was never made false by the correction at all —
   * `RESTATING_PROPERTIES` is where that is argued.
   */
  const stale: StaleRefinement[] = [];
  for (const [el, { field, ordinal }] of touched) {
    const id = el.attrs.get('id');
    if (id === undefined) continue;
    for (const meta of refinementsOf(view, id)) {
      if (refreshed.has(meta) || doomed.has(meta)) continue;
      const property = meta.attrs.get('property');
      if (property === undefined || !RESTATING_PROPERTIES.has(property)) continue;
      stale.push({ field, ordinal, property, value: textOf(view.source, meta) });
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
  const afterRoles = titleRoles(after);
  const metadata = {} as EpubMetadata;
  const counts = {} as Record<EpubMetaField, number>;
  for (const field of EPUB_META_FIELDS) {
    const found = after.byField.get(field)!;
    counts[field] = found.length;
    /*
     * `title` is the MAIN title, decided by the package's own refinements and
     * not by position — the same answer `--title` writes to, so what the dialog
     * shows and what the dialog edits cannot come apart. Everything else is the
     * first element of its field, and `identifier` is the one the package names.
     */
    const chosen = field === 'identifier' && after.uniqueIdentifier !== null
      ? found.find((el) => el.attrs.get('id') === after.uniqueIdentifier) ?? found[0]
      : field === 'title'
        ? afterRoles.main
        : found[0];
    metadata[field] = chosen === undefined ? null : textOf(after.source, chosen);
  }
  metadata.subtitle = afterRoles.subtitle === undefined
    ? null
    : textOf(after.source, afterRoles.subtitle);
  metadata.creators = after.byField.get('creator')!.map((el): EpubCreator => ({
    name: textOf(after.source, el),
    fileAs: fileAsOf(after, el),
  }));

  const report: EpubMetaReport = {
    outPath: inPlace ? opts.epubPath : (opts.outPath ?? opts.epubPath),
    inPlace,
    opfPath: book.opfPath,
    uniqueIdentifier: after.uniqueIdentifier,
    packageVersion,
    metadata,
    counts,
    changes,
    removed,
    // One entry per field, however many elements of it were given the value they
    // already held: "creator already said exactly that" is one fact about the
    // run, not one per author.
    unchanged: [...new Set(unchanged)],
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
