/**
 * archive — reading a book's documents and writing the book back out.
 *
 * Extracted from `footnotes-stage.ts` when `ocr-correct --epub` arrived, for the
 * reason `src/ocr/stage.ts` states about repairing a line: two implementations
 * of "write the edited book" is the same failure as two copies of a prompt
 * format. Within a month one of them re-deflates the untouched entries and the
 * other does not, both look like they work, and the difference shows up as a
 * book whose every file changed on a run that edited one paragraph.
 *
 * The two promises this module exists to keep:
 *
 *  - **The input file is never written to.** Callers pass an output path that is
 *    not the input; this module only ever writes where it is told.
 *  - **A document nobody edited comes back with the exact bytes, method and CRC
 *    it arrived with.** So a diff between the input and the output is exactly
 *    the set of documents an edit landed in — which is what makes a report
 *    reviewable and a stage re-runnable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32, writeZip, type ZipEntry } from '../export/zip.js';
import { METHOD_DEFLATE, type ZipReadEntry } from './zip-read.js';

/**
 * Refuse a document that is not UTF-8, naming it.
 *
 * A stage decodes a document, splices the decoded string, and re-encodes as
 * UTF-8. For a UTF-8 book that is a no-op outside the edit. For a Latin-1 or
 * UTF-16 one it would be a silent transcoding of the whole file — every accented
 * character in the book changed, on a run that reported success and did the job
 * it was asked to. So the decode is checked rather than assumed: a replacement
 * character means the bytes were not UTF-8, and a declared encoding that says so
 * means the publisher already told us.
 *
 * There is no transcoding path. Supporting one is a real feature (it has to
 * carry the declaration in the output too); pretending to support it is a
 * corrupted book.
 */
export function requireUtf8(stage: string, docPath: string, text: string): string {
  const declared = /encoding\s*=\s*["']([^"']+)["']/i.exec(text.slice(0, 400))?.[1]
    ?? /charset\s*=\s*["']?([\w-]+)/i.exec(text.slice(0, 2000))?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    throw new Error(
      `${stage}: ${docPath} declares encoding "${declared}". This stage reads and writes UTF-8 only, `
      + `and transcoding a book on the way past is not something it will do quietly.`,
    );
  }
  if (text.includes('�')) {
    throw new Error(
      `${stage}: ${docPath} is not valid UTF-8 (a replacement character appears after decoding). `
      + `This stage reads and writes UTF-8 only.`,
    );
  }
  return text;
}

/**
 * Write the archive back out, with only the edited documents replaced.
 *
 * Every other entry keeps its payload, its method and its CRC exactly — the
 * writer copies the compressed bytes rather than round-tripping them — and the
 * entry ORDER is the input's, which is what keeps a `mimetype`-first EPUB
 * `mimetype`-first.
 *
 * The edited documents are re-deflated here rather than in the writer:
 * `src/export/zip.ts` has no compressor and is not getting one. Written to a
 * temporary file and renamed, so an interrupted run leaves no half-EPUB with a
 * book's name on it.
 */
export function writeEditedEpub(
  archive: readonly ZipReadEntry[],
  edited: ReadonlyMap<string, string>,
  outputPath: string,
): void {
  const entries: ZipEntry[] = archive.map((entry) => {
    const text = edited.get(entry.path);
    if (text === undefined) {
      return {
        path: entry.path,
        data: entry.raw,
        method: entry.method === METHOD_DEFLATE ? 8 : 0,
        crc: entry.crc,
        uncompressedSize: entry.uncompressedSize,
      } as ZipEntry;
    }
    const plain = new TextEncoder().encode(text);
    if (entry.method !== METHOD_DEFLATE) {
      return { path: entry.path, data: plain };
    }
    return {
      path: entry.path,
      data: new Uint8Array(deflateRawSync(plain)),
      method: 8,
      crc: crc32(plain),
      uncompressedSize: plain.length,
    };
  });

  const out = writeZip(entries);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.partial`;
  fs.writeFileSync(staging, out);
  fs.renameSync(staging, outputPath);
}
