/**
 * document — the WORKING PDF, and the rules for writing into one.
 *
 * The document pipeline's model (docs/DOCUMENT_MODES.md): an untouched original
 * PDF is cast once into a `working.pdf`, and every stage after that writes INTO
 * that file. The first write is a full rewrite — that is `get-text` for a
 * scanned book and `scan --pdf` for one that already carries text — and every
 * write after it is a PDF INCREMENTAL UPDATE: bytes appended to the end, with
 * the objects they replace still present earlier in the file.
 *
 * Two properties follow from that, and they are the whole reason for this
 * module rather than a handful of pdf-lib calls at each call site:
 *
 *  - **The file is a valid PDF at every stage boundary.** Not "will be once the
 *    run finishes" — at every boundary, openable by any reader. That is what
 *    lets a stage be inspected, and it is what makes the pipeline
 *    document-in / document-out rather than a pile of run-directory state.
 *  - **A stage boundary is a BYTE OFFSET**, so "reset to stage" is
 *    `truncate(file, offset)`. `appendUpdate` returns the new length, which is
 *    the only thing a caller has to record to be able to go back.
 *
 * ## Failure discipline
 *
 * A failed stage writes NOTHING. The append bytes are built COMPLETELY in
 * memory first, so every error that can come out of pdf-lib — a bad object, an
 * unencodable string, a broken reference — lands before the file is touched.
 * The write itself is a single positional write at the old end followed by
 * `fsync`; if that write is short or throws, the file is truncated back to the
 * offset it had, because half an incremental update is a corrupt PDF and the
 * point of the whole design is that it never exists.
 *
 * ## Marking changes — the one pdf-lib rule that is easy to get wrong
 *
 * `saveIncremental` writes NEW objects automatically (their object number is
 * past the snapshot's high-water mark) and writes an EXISTING object only when
 * it has been marked. Mutating a page dictionary and saving without marking it
 * produces a perfectly valid update that silently does not contain the change —
 * measured, and the reason `markChanged` exists and every mutation of an
 * existing object in this repo goes through it.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRef, PDFString,
} from '@cantoo/pdf-lib';
import type { DocumentSnapshot } from '@cantoo/pdf-lib';

/** Errors from this module name the stage the caller is in. */
export class WorkingPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkingPdfError';
  }
}

/**
 * Which pipeline a working document belongs to, carried IN the document.
 *
 * `scanned` — the text layer is foundry's own, written by `get-text` over a
 * scan's line geometry. Its words came out of Tesseract, so they are repaired
 * by the ocr model before they are reflowed.
 * `text` — the document arrived with a publisher's text layer and `scan --pdf`
 * read it. Those words are already the author's; putting an OCR-repair model
 * over them would be a model editing text that has no OCR errors in it.
 *
 * This is a fact about the document, so it lives in the document. A side file
 * saying which one it is would be a second source of truth for whether a book
 * gets a model pointed at it, and the wrong answer is silent either way: a
 * missed repair reads as a bad scan, an unnecessary one reads as a bad model.
 */
export type DocumentClass = 'scanned' | 'text';
const DOCUMENT_CLASSES: readonly DocumentClass[] = ['scanned', 'text'];

/**
 * The document-level record foundry writes into the PDF catalog.
 *
 * Custom keys in the catalog under one dictionary, rather than scattered
 * second-class names: one key to find, one key to remove, and a `Version` that
 * a later build can refuse rather than misread.
 */
export interface FoundryMarker {
  /** This module's format version for the marker + annotation encoding. */
  version: number;
  documentClass: DocumentClass;
  /**
   * The language the text was produced under — the tessdata code for a scanned
   * book, the document's own `/Lang` for a text one. Null when nothing
   * declared one; the EPUB then says `und`, which is the ISO code that means
   * exactly that. Never guessed from the words.
   */
  language: string | null;
  /**
   * The dpi of the pixel frame block annotations and line geometry were
   * measured in. Foundry works in one frame everywhere — the scan's — so the
   * geometry the blocks model saw and the geometry an annotation carries are
   * the same numbers (see `src/pdf/frame.ts`).
   */
  dpi: number;
  /** sha256 of the ORIGINAL PDF this working document was cast from. */
  sourceSha256: string;
  /** The foundry build that cast it. */
  producer: string;
}

export const MARKER_VERSION = 1;

const FOUNDRY_KEY = PDFName.of('Foundry');
const K_VERSION = PDFName.of('Version');
const K_CLASS = PDFName.of('Class');
const K_LANG = PDFName.of('Lang');
const K_DPI = PDFName.of('Dpi');
const K_SOURCE = PDFName.of('SourceSHA256');
const K_PRODUCER = PDFName.of('Producer');

/** The page-level deleted flag. A page a user removed in the picker. */
export const PAGE_DELETED_KEY = PDFName.of('FoundryPageDeleted');

/**
 * Write (or replace) the foundry marker on a document's catalog.
 *
 * The caller marks the catalog changed; on a full rewrite there is nothing to
 * mark, and on an incremental update the catalog is an existing object.
 */
export function writeMarker(doc: PDFDocument, marker: FoundryMarker): void {
  const ctx = doc.context;
  const dict = ctx.obj({});
  dict.set(K_VERSION, PDFNumber.of(marker.version));
  dict.set(K_CLASS, PDFName.of(marker.documentClass));
  if (marker.language !== null) dict.set(K_LANG, PDFString.of(marker.language));
  dict.set(K_DPI, PDFNumber.of(marker.dpi));
  dict.set(K_SOURCE, PDFString.of(marker.sourceSha256));
  dict.set(K_PRODUCER, PDFString.of(marker.producer));
  doc.catalog.set(FOUNDRY_KEY, dict);
}

/**
 * Read the marker, or say which stage writes it.
 *
 * A PDF with no marker is not a working document — it is somebody's book — and
 * the difference decides whether a stage may write into it at all.
 */
export function readMarker(doc: PDFDocument): FoundryMarker {
  const dict = doc.catalog.lookup(FOUNDRY_KEY);
  if (!(dict instanceof PDFDict)) {
    throw new WorkingPdfError(
      'this PDF carries no foundry marker, so it is not a working document.\n'
      + 'A working document is cast from the original by `foundry get-text` (a scanned book: it '
      + 'writes the text layer) or by `foundry scan --pdf` (a book that already has text). Point '
      + 'this stage at the working PDF one of those wrote, not at the original.',
    );
  }
  const version = dict.lookup(K_VERSION);
  if (!(version instanceof PDFNumber) || version.asNumber() !== MARKER_VERSION) {
    throw new WorkingPdfError(
      `this working document declares foundry marker version `
      + `${version instanceof PDFNumber ? version.asNumber() : JSON.stringify(String(version))}, and this `
      + `build writes and reads version ${MARKER_VERSION}. Re-cast the working document from the original.`,
    );
  }
  const cls = dict.lookup(K_CLASS);
  const name = cls instanceof PDFName ? cls.decodeText() : '';
  if (!(DOCUMENT_CLASSES as readonly string[]).includes(name)) {
    throw new WorkingPdfError(
      `the foundry marker declares document class "${name}", and the classes are `
      + `${DOCUMENT_CLASSES.join(', ')}. Re-cast the working document from the original.`,
    );
  }
  const lang = dict.lookup(K_LANG);
  const dpi = dict.lookup(K_DPI);
  if (!(dpi instanceof PDFNumber)) {
    throw new WorkingPdfError('the foundry marker has no Dpi, so no geometry in it can be read. Re-cast the working document.');
  }
  const source = dict.lookup(K_SOURCE);
  const producer = dict.lookup(K_PRODUCER);
  return {
    version: MARKER_VERSION,
    documentClass: name as DocumentClass,
    language: lang instanceof PDFString ? lang.decodeText() : null,
    dpi: dpi.asNumber(),
    sourceSha256: source instanceof PDFString ? source.decodeText() : '',
    producer: producer instanceof PDFString ? producer.decodeText() : '',
  };
}

/** Is this page flagged deleted? Set by whoever edits the working document. */
export function isPageDeleted(page: PDFDict): boolean {
  return page.lookup(PAGE_DELETED_KEY) === PDFBool.True;
}

/**
 * A working PDF opened for an incremental update.
 *
 * Holds the bytes it was opened from, so the append can be verified against the
 * exact file it was computed against, and the snapshot pdf-lib needs to know
 * what changed.
 */
export class WorkingPdf {
  private constructor(
    readonly path: string,
    readonly doc: PDFDocument,
    private readonly snapshot: DocumentSnapshot,
    /** The file's length when it was opened — the boundary an append starts at. */
    readonly baseLength: number,
  ) {}

  static async open(path: string): Promise<WorkingPdf> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new WorkingPdfError(`no such working PDF: ${path}`);
    }
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, {
        forIncrementalUpdate: true,
        // The Info dictionary is the document's, not ours. Letting pdf-lib
        // stamp a ModDate on every save would put a change in every update
        // whether or not the stage changed anything.
        updateMetadata: false,
      });
    } catch (err) {
      throw new WorkingPdfError(
        `${path} could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new WorkingPdf(path, doc, doc.takeSnapshot(), bytes.length);
  }

  /** The marker, or the error naming the stage that writes one. */
  marker(): FoundryMarker {
    return readMarker(this.doc);
  }

  /**
   * Mark an object that already existed as changed, so the update carries it.
   *
   * Accepts the object or its reference: a page dictionary is reached as an
   * object, an `/Annots` array is often reached as a reference, and forgetting
   * which one is in hand is exactly how a change goes missing.
   */
  markChanged(target: PDFObject | PDFRef): void {
    if (target instanceof PDFRef) this.snapshot.markRefForSave(target);
    else this.snapshot.markObjForSave(target);
  }

  /** Write the marker and mark the catalog, which is always an existing object. */
  setMarker(marker: FoundryMarker): void {
    writeMarker(this.doc, marker);
    this.markChanged(this.doc.catalog);
  }

  /**
   * Build the update, append it, fsync, and return the file's new length.
   *
   * Nothing is written until the whole update exists as bytes. A failure during
   * the write truncates back to `baseLength`, because the alternative is a file
   * that is neither the old document nor the new one.
   */
  async appendUpdate(): Promise<number> {
    const diff = await this.doc.saveIncremental(this.snapshot);
    if (diff.length === 0) {
      throw new WorkingPdfError(
        `the update computed for ${this.path} is empty — the stage changed nothing, and writing a `
        + 'zero-byte increment would record a boundary that means nothing.',
      );
    }

    let fd: number;
    try {
      fd = openSync(this.path, 'r+');
    } catch {
      throw new WorkingPdfError(`${this.path} could not be opened for writing`);
    }
    try {
      const written = writeSync(fd, diff, 0, diff.length, this.baseLength);
      if (written !== diff.length) {
        throw new WorkingPdfError(
          `only ${written} of ${diff.length} bytes of the update reached ${this.path}`,
        );
      }
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      // Back to the boundary. A partial increment is a corrupt PDF, and the
      // document as it stood before this stage is the correct thing to leave.
      try { truncateSync(this.path, this.baseLength); } catch { /* nothing better to do */ }
      throw err;
    }
    closeSync(fd);
    return this.baseLength + diff.length;
  }
}

/**
 * Reset a working document to an earlier stage boundary.
 *
 * An incremental update only ever APPENDS, so every recorded boundary is still
 * a complete PDF with its own trailer — cutting the file there is the whole
 * undo. Refuses to grow a file, because a "boundary" past the end is a boundary
 * from a different document.
 */
export function truncateToBoundary(path: string, offset: number): void {
  let size: number;
  try {
    size = readFileSync(path).length;
  } catch {
    throw new WorkingPdfError(`no such working PDF: ${path}`);
  }
  if (offset > size) {
    throw new WorkingPdfError(
      `cannot reset ${path} to offset ${offset}: the file is ${size} bytes. That boundary was `
      + 'recorded against a different document.',
    );
  }
  truncateSync(path, offset);
}

/**
 * Write a document out whole — the ONE full rewrite, staged and renamed.
 *
 * This is what `get-text` and `scan --pdf` do, and it is deliberately not an
 * incremental update: a full rewrite through pdf-lib re-serializes every object
 * in one pass, which drops a linearization (a first-page layout that an append
 * silently invalidates — see docs/PDF_SPIKE.md) and gives every later stage a
 * file whose only trailer is one foundry wrote.
 */
export async function writeWholeDocument(doc: PDFDocument, target: string): Promise<number> {
  dropLinearization(doc);
  const bytes = await doc.save({ useObjectStreams: false });
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basenameOf(target)}.foundry-tmp`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the failure below is the news */ }
    throw err;
  }
  return bytes.length;
}

/**
 * Delete the linearization parameter dictionary, if the original had one.
 *
 * A linearized PDF opens with a dictionary declaring the file's own total
 * length and where its first page lives. Nothing REFERENCES that dictionary —
 * it is found by being the first object in the file — so a full rewrite carries
 * it along as an orphan, still saying `/L 3677256` about a file that is now a
 * different size. Measured: pdf-lib does exactly that (docs/PDF_SPIKE.md §5).
 *
 * A stale declaration is the kind of thing a reader is entitled to believe, so
 * the object goes. This is the de-linearization half of "get-text is a full
 * rewrite": the layout claim is not merely invalidated, it is removed.
 */
export function dropLinearization(doc: PDFDocument): number {
  const key = PDFName.of('Linearized');
  let dropped = 0;
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(key) !== undefined) {
      doc.context.delete(ref);
      dropped++;
    }
  }
  return dropped;
}

function basenameOf(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return at === -1 ? p : p.slice(at + 1);
}

/**
 * The `/Annots` array of a page, created if the page has none.
 *
 * Returns the array AND what has to be marked for the change to survive an
 * incremental update: the array itself when it is an indirect object, the page
 * dictionary when the array is direct or new.
 */
export function pageAnnots(
  doc: PDFDocument, page: PDFDict,
): { annots: PDFArray; mark: PDFObject | PDFRef } {
  const existing = page.get(PDFName.of('Annots'));
  if (existing instanceof PDFRef) {
    return { annots: doc.context.lookup(existing, PDFArray), mark: existing };
  }
  if (existing instanceof PDFArray) {
    return { annots: existing, mark: page };
  }
  const created = doc.context.obj([]) as PDFArray;
  page.set(PDFName.of('Annots'), created);
  return { annots: created, mark: page };
}
