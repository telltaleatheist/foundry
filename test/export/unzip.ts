/**
 * A minimal ZIP reader, for tests only.
 *
 * Deliberately NOT sharing code with `src/export/zip.ts`: a writer verified by
 * its own reader proves only that the two agree, and the failure that matters
 * is an archive no OTHER reader will open. This one parses the central
 * directory the way the spec says to — locate the EOCD by scanning back for its
 * signature, walk the entries, then read each local header independently and
 * check that it agrees with the central one — so a writer that filled in a
 * field in only one of the two places fails here.
 *
 * CRCs are verified on every entry.
 */

const EOCD_SIG = 0x06054B50;
const CENTRAL_SIG = 0x02014B50;
const LOCAL_SIG = 0x04034B50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export interface UnzippedEntry {
  path: string;
  data: Uint8Array;
  /** 0 is STORED. Anything else means the writer compressed something. */
  method: number;
  /** Offset of the local header, from the central directory. */
  localOffset: number;
  text(): string;
}

export class UnzipError extends Error {}

export function unzip(bytes: Uint8Array): UnzippedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number): number => view.getUint16(o, true);
  const u32 = (o: number): number => view.getUint32(o, true);

  // Scan back for the end-of-central-directory record.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new UnzipError('no end-of-central-directory record');

  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdStart = u32(eocd + 16);
  if (cdStart + cdSize > bytes.length) throw new UnzipError('central directory runs past the end of the archive');

  const decoder = new TextDecoder();
  const out: UnzippedEntry[] = [];
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

    // Read the local header independently and cross-check it.
    if (u32(localOffset) !== LOCAL_SIG) throw new UnzipError(`${path}: bad local header signature`);
    const lMethod = u16(localOffset + 8);
    const lCrc = u32(localOffset + 14);
    const lCsize = u32(localOffset + 18);
    const lUsize = u32(localOffset + 22);
    const lNameLen = u16(localOffset + 26);
    const lExtraLen = u16(localOffset + 28);
    const lPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + lNameLen));

    if (lPath !== path) throw new UnzipError(`central directory says "${path}", local header says "${lPath}"`);
    if (lMethod !== method) throw new UnzipError(`${path}: method ${lMethod} locally, ${method} centrally`);
    if (lCrc !== crc) throw new UnzipError(`${path}: crc mismatch between headers`);
    if (lCsize !== csize || lUsize !== usize) throw new UnzipError(`${path}: size mismatch between headers`);

    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(start, start + csize);
    if (method !== 0) throw new UnzipError(`${path}: method ${method} — this reader only handles STORED`);
    if (data.length !== usize) throw new UnzipError(`${path}: ${data.length} bytes, header says ${usize}`);
    const actual = crc32(data);
    if (actual !== crc) {
      throw new UnzipError(`${path}: crc32 ${actual.toString(16)}, header says ${crc.toString(16)}`);
    }

    out.push({ path, data, method, localOffset, text: () => decoder.decode(data) });
  }

  return out;
}

/** The archive's entries keyed by path. */
export function unzipMap(bytes: Uint8Array): Map<string, UnzippedEntry> {
  return new Map(unzip(bytes).map(e => [e.path, e] as const));
}
