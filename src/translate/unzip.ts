/**
 * translate/unzip — reading an EPUB back in, without disturbing what it holds.
 *
 * `src/export/zip.ts` writes archives and deliberately cannot read one. This is
 * the other half, and it exists because `foundry translate` is the first
 * command whose input is a book foundry already wrote: it opens an EPUB,
 * rewrites the words inside a few dozen documents, and hands back an archive
 * that is otherwise the SAME BOOK. That promise is the whole design of this
 * reader.
 *
 * WHY EVERY ENTRY IS RETURNED TWICE — once decoded, once as the raw bytes it
 * arrived as. A translation touches the chapter documents and the package, and
 * nothing else: not the stylesheet, not the nav's markup, and above all not the
 * cropped page images, which are the only large things in the container. An
 * entry nobody edited is written back out with the exact bytes, method and CRC
 * it came in with (`ZipEntry.method` 8 is a pass-through — see the header on
 * `src/export/zip.ts`), so a 40 MB book of scanned figures costs no re-encoding
 * and differs from its original only in the documents whose sentences actually
 * changed. Decoding a PNG to store it again would be work done to produce a
 * different file that means the same thing.
 *
 * DEFLATE IS READ, AND STILL NEVER WRITTEN. foundry's own EPUBs are stored
 * end to end, so the inflate path is dead code against foundry's output —
 * which is exactly why it is here. The input to this command is "an EPUB the
 * user believes foundry made", and that includes one that has been through a
 * calibre round trip, an EPUB-check repack, or a Windows "compressed folder".
 * A reader that refused those would refuse them with a ZIP diagnostic about a
 * file the person is looking at in a reading app. `node:zlib` is a Bun/Node
 * builtin, so this costs no dependency (ARCHITECTURE §1).
 *
 * THE TWO HEADERS ARE CROSS-CHECKED, like `test/export/unzip.ts` does. A file
 * whose central directory and local header disagree is not a file to guess
 * about: this command is about to rewrite it and give it back to somebody as
 * their book.
 */
import { inflateRawSync } from 'node:zlib';

/** A ZIP this reader will not parse. Always says which entry, or where. */
export class UnzipError extends Error {
  constructor(message: string) {
    super(`epub: ${message}`);
    this.name = 'UnzipError';
  }
}

const EOCD_SIG = 0x06054B50;
const CENTRAL_SIG = 0x02014B50;
const LOCAL_SIG = 0x04034B50;

const STORED = 0;
const DEFLATED = 8;

/**
 * One entry, in both of the forms a rewriting command needs.
 *
 * `data` is what the entry SAYS; `raw`/`method`/`crc`/`uncompressedSize` are
 * what the entry IS. Give the first to a parser and the second to the writer
 * and an untouched entry comes out byte-identical.
 */
export interface ZipMember {
  path: string;
  /** The content, inflated if it had to be. */
  data: Uint8Array;
  /** The bytes as stored, still compressed when `method` is 8. */
  raw: Uint8Array;
  method: number;
  crc: number;
  uncompressedSize: number;
  /** The content as UTF-8 text. */
  text(): string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Parse an archive into its entries, in central-directory order.
 *
 * Zip64 is not implemented here either, and an archive that needs it says so
 * rather than being read wrong: a 32-bit size field holding 0xFFFFFFFF is the
 * spec's "look in the extra field", and taking it literally would hand back
 * four gigabytes of somebody else's file.
 */
export function readZip(bytes: Uint8Array): ZipMember[] {
  if (bytes.length < 22) throw new UnzipError(`${bytes.length} bytes is too short to be a ZIP archive`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number): number => view.getUint16(o, true);
  const u32 = (o: number): number => view.getUint32(o, true);

  // Scan back for the end-of-central-directory record. It is last, but a ZIP
  // may carry a trailing comment, so its position is only findable this way.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new UnzipError('no end-of-central-directory record — this file is not a ZIP archive, and an EPUB is one');
  }

  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdStart = u32(eocd + 16);
  if (cdStart === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {
    throw new UnzipError('this archive is zip64, which this reader does not implement');
  }
  if (cdStart + cdSize > bytes.length) {
    throw new UnzipError('the central directory runs past the end of the file — the archive is truncated');
  }

  const decoder = new TextDecoder();
  const out: ZipMember[] = [];
  let p = cdStart;

  for (let n = 0; n < count; n++) {
    if (u32(p) !== CENTRAL_SIG) throw new UnzipError(`entry ${n}: bad central directory signature`);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      throw new UnzipError(`entry "${path}" is zip64, which this reader does not implement`);
    }

    // The local header is read independently and cross-checked. A writer that
    // filled a field in only one of the two places produces an archive that
    // some readers open and some do not, and this command's output would
    // inherit the defect silently.
    if (localOffset + 30 > bytes.length || u32(localOffset) !== LOCAL_SIG) {
      throw new UnzipError(`entry "${path}": bad local header signature`);
    }
    const lFlags = u16(localOffset + 6);
    const lMethod = u16(localOffset + 8);
    const lNameLen = u16(localOffset + 26);
    const lExtraLen = u16(localOffset + 28);
    const lPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + lNameLen));
    if (lPath !== path) {
      throw new UnzipError(`the central directory says "${path}", its local header says "${lPath}"`);
    }
    if (lMethod !== method) {
      throw new UnzipError(`entry "${path}": method ${lMethod} locally, ${method} centrally`);
    }
    /*
     * Bit 3 says the sizes and the CRC are in a data descriptor AFTER the
     * payload rather than in the local header. The central directory still
     * carries the true values — which is what this reader uses — so the entry
     * is readable; what it must not do is trust the zeroes in the local
     * header. Nothing else here reads those fields, so the flag is checked
     * only to keep the cross-check below from firing on a legal archive.
     */
    const streamed = (lFlags & 0x08) !== 0;
    if (!streamed) {
      const lCrc = u32(localOffset + 14);
      const lCsize = u32(localOffset + 18);
      const lUsize = u32(localOffset + 22);
      if (lCrc !== crc) throw new UnzipError(`entry "${path}": the two headers disagree about its checksum`);
      if (lCsize !== csize || lUsize !== usize) {
        throw new UnzipError(`entry "${path}": the two headers disagree about its size`);
      }
    }

    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + csize > bytes.length) {
      throw new UnzipError(`entry "${path}" runs past the end of the file — the archive is truncated`);
    }
    const raw = bytes.slice(start, start + csize);

    let data: Uint8Array;
    if (method === STORED) {
      data = raw;
    } else if (method === DEFLATED) {
      try {
        data = new Uint8Array(inflateRawSync(raw));
      } catch (error) {
        throw new UnzipError(`entry "${path}" is deflated and would not inflate: ${(error as Error).message}`);
      }
    } else {
      throw new UnzipError(
        `entry "${path}" uses compression method ${method}; this reader implements stored (0) and deflate (8)`,
      );
    }

    if (data.length !== usize) {
      throw new UnzipError(`entry "${path}" is ${data.length} bytes, its header says ${usize}`);
    }
    const actual = crc32(data);
    if (actual !== crc) {
      throw new UnzipError(
        `entry "${path}" fails its checksum (${actual.toString(16)} against ${crc.toString(16)}) — the file is damaged`,
      );
    }

    out.push({
      path, data, raw, method, crc, uncompressedSize: usize,
      text: () => new TextDecoder().decode(data),
    });
  }

  return out;
}

/** The archive's entries keyed by path, for the lookups a package walk does. */
export function readZipMap(bytes: Uint8Array): Map<string, ZipMember> {
  return new Map(readZip(bytes).map((m) => [m.path, m] as const));
}
