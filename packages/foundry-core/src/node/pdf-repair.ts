/**
 * pdf-repair — a damaged PDF is rebuilt into a sound one before anybody reads it.
 *
 * Owen, 2026-11-08: a scan opened in the PDF view as *"This PDF would not open —
 * Page dictionary kid reference points to wrong type of object"*. Its xref offsets
 * were wrong, and five entries of its 388-entry page tree point at objects that are
 * not in the file (objects 772–801 are absent, the archive copy too). MuPDF repairs
 * the xref on open and reads the 383 pages that are there; pdf.js, which draws the
 * view, read 120 entries and threw at the first missing one.
 *
 * Fixing the viewer would fix one reader. The owner is the copy: `working/` is the
 * document every reader in the app is handed, so a damaged import is rebuilt THERE,
 * once, and `archive/` keeps the original bytes untouched (projects-paths.ts says
 * why nothing writes to it). The rebuild grafts every PAGE MuPDF found into a fresh
 * document with one graft map, so an outline's page references follow their pages,
 * and carries the document's info and page labels with it. An entry that is not a
 * page is left out and named in the sentence: grafting it would make a blank page
 * that looks like part of the book.
 *
 * A REBUILD IS A VERIFIED STATE: the bytes are opened again and must pass the same
 * check with the same page count, or the answer is that the file could not be
 * rebuilt, in a sentence, and the working copy is left as it was.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeAtomically } from './atomic';
import { WORKING, projectDirOf } from './projects-paths';

/*
 * The part of MuPDF this file uses, spelled out: its declarations are reachable only
 * through `exports`, which this program's `moduleResolution: node` does not read.
 */
interface MupdfObject {
  isNull(): boolean;
  isIndirect(): boolean;
  isArray(): boolean;
  isDictionary(): boolean;
  asIndirect(): number;
  asName(): string;
  resolve(): MupdfObject;
  readonly length: number;
  get(key: string | number): MupdfObject;
  put(key: string, value: MupdfObject): void;
}
interface MupdfGraftMap {
  graftObject(obj: MupdfObject): MupdfObject;
  graftPage(to: number, srcDoc: MupdfDocument, srcPage: number): void;
}
interface MupdfDocument {
  getTrailer(): MupdfObject;
  countPages(): number;
  findPage(index: number): MupdfObject;
  wasRepaired(): boolean;
  newGraftMap(): MupdfGraftMap;
  saveToBuffer(options: string): { asUint8Array(): Uint8Array };
  destroy(): void;
}
interface Mupdf {
  PDFDocument: new (data?: Uint8Array) => MupdfDocument;
}

/*
 * THE IMPORT HAS TO STAY AN IMPORT. This file compiles to CommonJS, where tsc turns
 * `import()` into `require()`, and `mupdf` is an ES module with top-level await that
 * `require` cannot load. A function built from source is not rewritten.
 */
const importModule = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<unknown>;

let loading: Promise<Mupdf> | null = null;

function loadMupdf(): Promise<Mupdf> {
  loading ??= (async () => {
    const mupdf = await importModule(pathToFileURL(require.resolve('mupdf')).href) as Mupdf;
    return mupdf;
  })();
  return loading;
}

/** What a look at a PDF found. */
export type PdfHealth =
  | { state: 'sound'; pages: number }
  | {
    state: 'rebuilt';
    /** Pages in the rebuilt copy. */
    pages: number;
    /** 1-based places in the page list that held no page and were left out. */
    dropped: number[];
    bytes: Buffer;
    why: string;
  }
  | { state: 'unrepairable'; why: string };

/** The root entries that travel with the pages. The rest (forms, structure) is per-page or lost with the tree. */
const ROOT_CARRIED = ['Outlines', 'PageLabels'] as const;

/**
 * A leaf that is a page. MuPDF hands back whatever the tree points at — on the
 * 2026-11-08 scan, five objects that are not in the file at all and so read as
 * null; in the keeper, a font — and grafting one makes a blank page out of it.
 */
function isPage(leaf: MupdfObject): boolean {
  const resolved = leaf.resolve();
  if (!resolved.isDictionary() || !resolved.get('Kids').isNull()) return false;
  const type = resolved.get('Type');
  if (!type.isNull()) return type.asName() === 'Page';
  return !resolved.get('Contents').isNull() || !resolved.get('Resources').isNull();
}

interface TreeShape {
  /** Leaves under the root's /Pages that are pages. */
  leaves: number;
  /** The first thing in the tree that is neither a page nor a node of pages, in words; null when there was none. */
  strange: string | null;
}

function treeShape(doc: MupdfDocument): TreeShape {
  const shape: TreeShape = { leaves: 0, strange: null };
  const seen = new Set<number>();
  const walk = (node: MupdfObject, where: string): void => {
    if (shape.strange !== null) return;
    if (node.isIndirect()) {
      const number = node.asIndirect();
      if (seen.has(number)) {
        shape.strange = `${where} points back into the tree (object ${number})`;
        return;
      }
      seen.add(number);
    }
    const resolved = node.resolve();
    if (!resolved.isDictionary()) {
      shape.strange = `${where} is ${resolved.isNull() ? 'missing from the file' : 'not a dictionary'}`;
      return;
    }
    const kids = resolved.get('Kids');
    if (kids.isNull()) {
      if (!isPage(resolved)) {
        const type = resolved.get('Type');
        shape.strange = `${where} is ${type.isNull() ? 'not a page' : `a /${type.asName()}, not a page`}`;
        return;
      }
      shape.leaves += 1;
      return;
    }
    if (!kids.isArray()) {
      shape.strange = `${where}'s /Kids is not a list`;
      return;
    }
    for (let i = 0; i < kids.length; i++) walk(kids.get(i), `entry ${i + 1} of ${where}`);
  };
  walk(doc.getTrailer().get('Root').get('Pages'), 'the page tree');
  return shape;
}

interface Look {
  /** Places in the page list, pages or not. */
  places: number;
  /** Why this file needs rebuilding; null when it does not. */
  damage: string | null;
}

/**
 * Every page found, then the questions. MuPDF repairs lazily, so `wasRepaired()`
 * means something only after each page has been looked up; the tree is walked
 * first because the lookups are what fall back to a scan of the whole file.
 */
function look(doc: MupdfDocument): Look {
  const shape = treeShape(doc);
  const places = doc.countPages();
  for (let i = 0; i < places; i++) doc.findPage(i);
  const damage = [
    doc.wasRepaired() ? 'its cross-reference table was wrong and had to be rebuilt' : null,
    shape.strange !== null
      ? `its page tree is broken (${shape.strange})`
      : shape.leaves !== places ? `its page tree lists ${shape.leaves} pages where ${places} were found` : null,
  ].filter((reason): reason is string => reason !== null);
  return { places, damage: damage.length === 0 ? null : damage.join(', and ') };
}

interface Rebuilt {
  bytes: Buffer;
  pages: number;
  dropped: number[];
}

function rebuild(mupdf: Mupdf, src: MupdfDocument, places: number): Rebuilt {
  const dst = new mupdf.PDFDocument();
  const map = dst.newGraftMap();
  const dropped: number[] = [];
  for (let i = 0; i < places; i++) {
    if (isPage(src.findPage(i))) map.graftPage(-1, src, i);
    else dropped.push(i + 1);
  }
  const info = src.getTrailer().get('Info');
  if (!info.isNull()) dst.getTrailer().put('Info', map.graftObject(info));
  const root = src.getTrailer().get('Root');
  for (const key of ROOT_CARRIED) {
    const entry = root.get(key);
    if (!entry.isNull()) dst.getTrailer().get('Root').put(key, map.graftObject(entry));
  }
  try {
    return {
      bytes: Buffer.from(dst.saveToBuffer('garbage=compact,compress').asUint8Array()),
      pages: places - dropped.length,
      dropped,
    };
  } finally {
    dst.destroy();
  }
}

/** The words for an open MuPDF refused, which is the file's fault and said as such. */
const refusal = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A document opened for `use` and freed after it, thrown or not. A 400 MB scan is
 * held inside MuPDF's heap for as long as its document lives, so none waits for
 * the collector.
 */
function opened<T>(mupdf: Mupdf, bytes: Uint8Array, use: (doc: MupdfDocument) => T): T {
  const doc = new mupdf.PDFDocument(bytes);
  try {
    return use(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Look at a PDF's bytes and, when it is damaged, rebuild it. Never throws for a
 * damaged file: a file that cannot be opened or rebuilt is `unrepairable`, with why.
 */
export async function checkPdf(bytes: Uint8Array): Promise<PdfHealth> {
  const mupdf = await loadMupdf();
  type Outcome = { found: Look } | { found: Look; made: Rebuilt } | { unread: string };
  let outcome: Outcome;
  try {
    outcome = opened(mupdf, bytes, (src) => {
      const found = look(src);
      if (found.damage === null) return { found };
      try {
        return { found, made: rebuild(mupdf, src, found.places) };
      } catch (err) {
        return { unread: `${found.damage}, and rebuilding it failed (${refusal(err)})` };
      }
    });
  } catch (err) {
    return { state: 'unrepairable', why: `MuPDF could not read it (${refusal(err)})` };
  }
  if ('unread' in outcome) return { state: 'unrepairable', why: outcome.unread };
  const { found } = outcome;
  if (!('made' in outcome) || found.damage === null) return { state: 'sound', pages: found.places };
  const { made } = outcome;
  if (made.pages === 0) return { state: 'unrepairable', why: `${found.damage}, and not one page in it could be read` };
  let again: Look;
  try {
    again = opened(mupdf, made.bytes, look);
  } catch (err) {
    return { state: 'unrepairable', why: `${found.damage}, and the rebuilt copy would not open (${refusal(err)})` };
  }
  if (again.damage !== null || again.places !== made.pages) {
    return {
      state: 'unrepairable',
      why: `${found.damage}, and the rebuilt copy did not hold `
        + `(${again.damage ?? `${again.places} pages where ${made.pages} were kept`})`,
    };
  }
  return { state: 'rebuilt', pages: made.pages, dropped: made.dropped, bytes: made.bytes, why: found.damage };
}

/** "120–124" and "7, 9": runs of places, for the sentence. */
function runs(places: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < places.length;) {
    let j = i;
    while (j + 1 < places.length && places[j + 1] === (places[j] as number) + 1) j++;
    out.push(i === j ? `${places[i]}` : `${places[i]}–${places[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** The one sentence a person is told about a rebuilt or unrepairable working copy. */
export function repairSentence(file: string, health: Exclude<PdfHealth, { state: 'sound' }>): string {
  const name = path.basename(file);
  if (health.state === 'unrepairable') return `${name} is damaged and could not be rebuilt: ${health.why}.`;
  const holds = `${health.pages} page${health.pages === 1 ? '' : 's'}`;
  const gone = health.dropped.length === 0
    ? ''
    : `, leaving out ${health.dropped.length === 1 ? 'entry' : 'entries'} ${runs(health.dropped)} of its page list, `
      + `which held no page`;
  return `${name} was damaged (${health.why}), so its working copy was rebuilt and holds ${holds}${gone}; `
    + 'the original is unchanged in archive/.';
}

/** True for a PDF in a project's `working/`, the one layer this file may rewrite. */
export function isWorkingPdf(file: string): boolean {
  const resolved = path.resolve(file);
  const project = projectDirOf(resolved);
  if (project === null || path.extname(resolved).toLowerCase() !== '.pdf') return false;
  return path.relative(project, resolved).split(path.sep)[0] === WORKING;
}

/*
 * ONE LOOK PER FILE AS IT STANDS, keyed by size and modification time, so a book
 * opened twice is read by MuPDF once and an edit that rewrites the file is looked
 * at again. One look at a time per file, so two windows opening the same book do
 * not both rebuild it.
 */
/*
 * WHO HEARS THE SENTENCE: one listener, replaced rather than appended, set by the
 * window that shows the notice strip (app/electron/ipc-documents.ts) the way
 * `onImportLanded` is. The console always has it.
 */
let pdfNoticed: (sentence: string) => void = () => { /* set by the window */ };

export function onPdfNotice(listener: (sentence: string) => void): void {
  pdfNoticed = listener;
}

const looked = new Map<string, { stamp: string; sentence: string | null }>();
const looking = new Map<string, Promise<string | null>>();

const stampOf = async (file: string): Promise<string> => {
  const stat = await fsp.stat(file);
  return `${stat.size}:${stat.mtimeMs}`;
};

/**
 * Rebuild a project's working PDF in place when it is damaged. The answer is the
 * sentence for a person — rebuilt, or damaged past rebuilding — or null for a
 * sound file. `archive/` is never passed here (`isWorkingPdf` is the gate).
 */
export function healWorkingPdf(file: string): Promise<string | null> {
  const resolved = path.resolve(file);
  if (!isWorkingPdf(resolved)) {
    throw new Error(`${resolved} is not a PDF in a project's working/ folder, so it is not this app's to rebuild.`);
  }
  const running = looking.get(resolved);
  if (running !== undefined) return running;
  const attempt = (async () => {
    const stamp = await stampOf(resolved);
    const known = looked.get(resolved);
    if (known !== undefined && known.stamp === stamp) return known.sentence;
    const health = await checkPdf(await fsp.readFile(resolved));
    if (health.state === 'sound') {
      looked.set(resolved, { stamp, sentence: null });
      return null;
    }
    if (health.state === 'rebuilt') await writeAtomically(resolved, health.bytes);
    const sentence = repairSentence(resolved, health);
    // Said once: a rebuilt file is sound as it now stands, and an unrepairable one
    // keeps its sentence for the caller without being told to a window again.
    looked.set(resolved, { stamp: await stampOf(resolved), sentence: health.state === 'rebuilt' ? null : sentence });
    console.warn(`[projects] ${sentence}`);
    pdfNoticed(sentence);
    return sentence;
  })().finally(() => { looking.delete(resolved); });
  looking.set(resolved, attempt);
  return attempt;
}
