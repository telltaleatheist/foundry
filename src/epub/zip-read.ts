/**
 * zip-read — read an existing ZIP archive, entry by entry, without decoding
 * anything the caller did not ask for.
 *
 * `src/export/zip.ts` WRITES the container foundry builds from a scan. This
 * file reads a container somebody else built, because `foundry footnotes
 * --epub` takes a real EPUB from a real publisher and has to give one back.
 * The two are deliberately separate modules: the writer is store-only by
 * design, and a reader that shares its code would be a reader that can only
 * read foundry's own archives. Every EPUB in the wild is deflated.
 *
 * Two properties this reader is built around:
 *
 *  - **The central directory is the authority.** Sizes and CRCs are taken from
 *    it, never from the local header, because an archive written by a streaming
 *    writer legitimately carries zeros in the local header and puts the real
 *    values in a data descriptor after the payload. The local header is read
 *    only for its name and extra-field lengths, which is the one thing it alone
 *    knows — where the bytes start.
 *  - **The raw bytes come back untouched.** An entry carries the payload
 *    exactly as it sits in the archive, with its method and its CRC, so an
 *    entry nobody edited can be written back out byte-identical rather than
 *    round-tripped through inflate and deflate. That is what makes "everything
 *    else copied through unchanged" literally true.
 *
 * NO FALLBACKS (ARCHITECTURE §8): a truncated archive, an unknown compression
 * method and a CRC that does not match after inflation are each an error naming
 * the entry. A book is not something to half-read.
 */
import { inflateRawSync } from 'node:zlib';

import { crc32 } from '../export/zip.js';

/** STORED — the payload is the content. */
export const METHOD_STORE = 0;
/** DEFLATE — the payload is a raw deflate stream. */
export const METHOD_DEFLATE = 8;

export interface ZipReadEntry {
  /** The name as the archive spells it, forward-slashed. */
  path: string;
  /** 0 (stored) or 8 (deflate). Anything else was refused at read time. */
  method: number;
  /** CRC-32 of the UNCOMPRESSED content, from the central directory. */
  crc: number;
  /** Size of the uncompressed content, from the central directory. */
  uncompressedSize: number;
  /** The payload exactly as it appears in the archive — compressed if method 8. */
  raw: Uint8Array;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(`zip: ${message}`);
    this.name = 'ZipReadError';
  }
}

const EOCD_SIG = 0x06054B50;
const CENTRAL_SIG = 0x02014B50;
const LOCAL_SIG = 0x04034B50;

/**
 * Parse an archive into its entries, in central-directory order.
 *
 * Order is preserved because an EPUB's first entry has to stay its first entry:
 * OCF requires an uncompressed `mimetype` at a fixed byte offset, and a reader
 * that returned a map would leave the writer to invent an order.
 */
export function readZip(bytes: Uint8Array): ZipReadEntry[] {
  if (bytes.length < 22) throw new ZipReadError(`archive is ${bytes.length} bytes — too short to hold a ZIP`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number): number => view.getUint16(o, true);
  const u32 = (o: number): number => view.getUint32(o, true);

  // The EOCD is last, but a trailing comment can push it back up to 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipReadError('no end-of-central-directory record — this is not a ZIP archive');

  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdStart = u32(eocd + 16);
  if (cdStart + cdSize > bytes.length) {
    throw new ZipReadError('the central directory runs past the end of the archive — the file is truncated');
  }

  const decoder = new TextDecoder();
  const out: ZipReadEntry[] = [];
  let p = cdStart;

  for (let n = 0; n < count; n++) {
    if (u32(p) !== CENTRAL_SIG) {
      throw new ZipReadError(`entry ${n}: bad central-directory signature at offset ${p}`);
    }
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compressedSize = u32(p + 20);
    const uncompressedSize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipReadError(
        `"${path}" uses compression method ${method}; this reader handles STORED and DEFLATE only`,
      );
    }
    if (u32(localOffset) !== LOCAL_SIG) {
      throw new ZipReadError(`"${path}": no local header at offset ${localOffset}`);
    }
    // The local header's own name/extra lengths, and ONLY those: its sizes and
    // CRC are unreliable by design when a data descriptor is in use.
    const lNameLen = u16(localOffset + 26);
    const lExtraLen = u16(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compressedSize > bytes.length) {
      throw new ZipReadError(`"${path}": its payload runs past the end of the archive`);
    }

    out.push({
      path,
      method,
      crc,
      uncompressedSize,
      raw: bytes.slice(start, start + compressedSize),
    });
  }

  return out;
}

/**
 * The entry's content, decompressed if it needs to be, CRC-checked either way.
 *
 * The check is not optional. An EPUB whose XHTML inflates to something other
 * than what the publisher wrote is a corrupt file, and the alternative to
 * saying so is a book edited on the strength of garbage.
 */
export function entryBytes(entry: ZipReadEntry): Uint8Array {
  const data = entry.method === METHOD_DEFLATE
    ? new Uint8Array(inflateRawSync(entry.raw))
    : entry.raw;
  if (data.length !== entry.uncompressedSize) {
    throw new ZipReadError(
      `"${entry.path}": ${data.length} bytes after decompression, the directory says ${entry.uncompressedSize}`,
    );
  }
  const actual = crc32(data);
  if (actual !== entry.crc) {
    throw new ZipReadError(
      `"${entry.path}": crc32 ${actual.toString(16)}, the directory says ${entry.crc.toString(16)}`,
    );
  }
  return data;
}

/** The entry's content decoded as UTF-8 text. */
export function entryText(entry: ZipReadEntry): string {
  return new TextDecoder('utf-8').decode(entryBytes(entry));
}
