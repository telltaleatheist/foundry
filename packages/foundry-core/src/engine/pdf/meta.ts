/**
 * pdf/meta — the four Info-dictionary fields of a PDF, read and rewritten.
 *
 * THIS COMMAND REWRITES THE WHOLE FILE, and that is stated here rather than
 * left to be discovered. It is the exact opposite of what `epub/meta.ts` does
 * one directory over, which goes to great lengths to leave every byte it was
 * not asked about exactly where it was. Here the document is parsed by pdf-lib, one
 * dictionary is edited, and pdf-lib writes a NEW file from its own object model:
 * the objects are renumbered, the cross-reference table is rebuilt, streams are
 * re-emitted, and anything in the original that pdf-lib does not model does not
 * come out the other side.
 *
 * That is acceptable HERE and nowhere else, for one reason: `--out` is the
 * WORKING PDF, and `archive/` holds the file that came in, byte for byte,
 * forever. The working copy is a derived artifact and can be made again from the
 * original at any time ("Start over" in the project model does exactly that).
 * The alternative — a PDF incremental update appending an Info dict and a new
 * trailer by hand — is real work: cross-reference stream parsing, `/Prev`
 * chaining, and a hand-built trailer
 * that a strict reader will reject if one offset is wrong. It buys byte fidelity
 * that this program does not need at this point in the pipeline, and it would be
 * a second, subtler PDF writer to maintain beside the one that already exists.
 *
 * `updateMetadata: false` on the load, for `pdf-text.ts`'s reason, and it
 * matters MORE here than there: pdf-lib otherwise stamps its own `Producer` and
 * a fresh `ModDate` over the document's — so a command whose entire purpose is
 * to write exactly the metadata it was given would silently write two fields it
 * was not. A scan whose Producer now names a JavaScript library is a document
 * quietly signed by something that did not make it.
 *
 * WHAT IS NOT HERE: XMP. A PDF can carry the same facts twice, in the Info
 * dictionary and in an XMP packet, and readers disagree about which wins.
 * foundry writes the Info dictionary — which is what every viewer's Properties
 * panel shows and what every indexer reads first — and does not touch an XMP
 * packet it did not write, because a half-updated pair is worse than a
 * consistent old one: the file would then state two different titles, and which
 * one a given program believed would depend on the program.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PDFDocument } from 'pdf-lib';

/** A PDF this command will not read or will not write. Always names the file or the flag. */
export class PdfMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfMetaError';
  }
}

/**
 * The four Info-dictionary fields this command writes.
 *
 * Four, because these are the four a document has as a DOCUMENT rather than as
 * an artifact of the tool that produced it. `Producer` and `Creator` are
 * statements about the software chain and are read below but never written —
 * rewriting them would be this program claiming to have produced somebody's
 * scan. `CreationDate` and `ModDate` are the same argument in a different
 * spelling.
 */
export const PDF_META_FIELDS = ['title', 'author', 'subject', 'keywords'] as const;

export type PdfMetaField = (typeof PDF_META_FIELDS)[number];

/** What the Info dictionary says. `null` is "the dictionary carries no such entry". */
export interface PdfMetadata extends Record<PdfMetaField, string | null> {
  /** Read, never written: the software chain that made the file. */
  creator: string | null;
  producer: string | null;
  /** So a caller can tell it is looking at the document it thinks it is. */
  pages: number;
}

export interface PdfMetaChange {
  field: PdfMetaField;
  /** What the entry said. `null` when the dictionary had no such entry. */
  from: string | null;
  to: string;
  /** True when the Info dictionary carried no entry for this field at all. */
  created: boolean;
}

export interface PdfMetaReport {
  /** The file written, or the input when the run only read. */
  outPath: string;
  /** The metadata as it stands AFTER any writes — what `--json` prints. */
  metadata: PdfMetadata;
  /** Field by field, old → new. Empty when the run only read. */
  changes: PdfMetaChange[];
  /** Fields given a value they already held, so nothing was written for them. */
  unchanged: PdfMetaField[];
  /** False for a read-only run, and for a run whose every setter was a no-op. */
  written: boolean;
}

export interface PdfMetaOptions {
  /** The PDF to read. Never written to. */
  pdfPath: string;
  /** Where the edited PDF is written. Required when a field is being set. */
  outPath?: string | undefined;
  /** The fields to set. A field absent here is not touched. */
  set?: Partial<Record<PdfMetaField, string>> | undefined;
  log: (message: string) => void;
}

/**
 * An Info entry as a string, or null.
 *
 * pdf-lib's getters return `undefined` for an absent entry and throw nothing for
 * a present one, so the only translation needed is the one to `null` — which is
 * what JSON has and what a dialog field binds to.
 */
function orNull(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function readAll(doc: PDFDocument): PdfMetadata {
  return {
    title: orNull(doc.getTitle()),
    author: orNull(doc.getAuthor()),
    subject: orNull(doc.getSubject()),
    keywords: orNull(doc.getKeywords()),
    creator: orNull(doc.getCreator()),
    producer: orNull(doc.getProducer()),
    pages: doc.getPageCount(),
  };
}

export async function pdfMeta(opts: PdfMetaOptions): Promise<PdfMetaReport> {
  const set = opts.set ?? {};
  const wanted = PDF_META_FIELDS.filter((f) => set[f] !== undefined);

  for (const field of wanted) {
    if (set[field]!.trim() === '') {
      throw new PdfMetaError(
        `--${field} was given an empty value. foundry does not blank an Info entry: an empty Title `
        + 'is a document that claims to be called nothing, which reads differently from one that '
        + 'never said. Pass the new text, or leave the flag out and the entry is not touched.',
      );
    }
  }

  /*
   * `--out` is required only when the run WRITES, exactly as in `epub-meta`.
   * Reading the metadata is the app's first act when the dialog opens, and
   * demanding an output path for a question would mean writing a copy of a
   * 300 MB scan in order to answer it.
   */
  if (wanted.length > 0 && (opts.outPath === undefined || opts.outPath === '')) {
    throw new PdfMetaError(
      `${opts.pdfPath}: --out says where the edited PDF is written, and no --out was given. `
      + 'foundry never writes over an input. Reading the metadata needs no --out at all.',
    );
  }
  if (opts.outPath !== undefined && path.resolve(opts.outPath) === path.resolve(opts.pdfPath)) {
    throw new PdfMetaError(
      `--out ${opts.outPath} is the input itself. This command REWRITES THE WHOLE FILE through `
      + 'pdf-lib rather than patching it in place, so an --out equal to --pdf would destroy the '
      + 'document being read while it was being read.',
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(opts.pdfPath));
  } catch (error) {
    throw new PdfMetaError(
      `${opts.pdfPath} cannot be read: `
      + `${(error as NodeJS.ErrnoException).code ?? (error as Error).message}. --pdf takes a PDF file.`,
    );
  }

  let doc: PDFDocument;
  try {
    // `updateMetadata: false` — see this file's header. It is the difference
    // between writing the fields that were asked for and writing those plus
    // Producer and ModDate.
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new PdfMetaError(
      `${opts.pdfPath} could not be opened as a PDF (${(error as Error).message}). An encrypted `
      + 'document is the usual answer; foundry does not strip a password it was not given.',
    );
  }

  const before = readAll(doc);

  const changes: PdfMetaChange[] = [];
  const unchanged: PdfMetaField[] = [];
  for (const field of wanted) {
    const value = set[field]!;
    const was = before[field];
    if (was === value) {
      // Given the value it already holds. The file is not rewritten for it, so
      // a dialog saved without an edit leaves the working PDF byte-identical.
      unchanged.push(field);
      continue;
    }
    switch (field) {
      case 'title': doc.setTitle(value); break;
      case 'author': doc.setAuthor(value); break;
      case 'subject': doc.setSubject(value); break;
      // `setKeywords` takes a LIST and joins it with spaces, which would turn
      // "war, germany, 1933" into three keywords and back into one string with
      // the commas still in it. One element means the caller's own text goes
      // into the entry verbatim — the separator is the caller's business, and
      // PDF has never standardised one.
      case 'keywords': doc.setKeywords([value]); break;
    }
    changes.push({ field, from: was, to: value, created: was === null });
  }

  const written = changes.length > 0;
  if (!written) {
    return { outPath: opts.outPath ?? opts.pdfPath, metadata: before, changes, unchanged, written };
  }

  const out = await doc.save();
  fs.writeFileSync(opts.outPath!, out);
  opts.log(
    `pdf-meta: ${opts.outPath} written, ${out.length} bytes, ${before.pages} pages — the whole `
    + 'file is re-emitted by pdf-lib, and the original is untouched',
  );

  return {
    outPath: opts.outPath!,
    metadata: readAll(doc),
    changes,
    unchanged,
    written,
  };
}
