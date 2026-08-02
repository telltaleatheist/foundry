/**
 * zip — a store-only ZIP writer, in pure TypeScript, with no dependency.
 *
 * Foundry ships as a compiled standalone binary and has zero runtime
 * dependencies, so the EPUB container is built here. That is a smaller job than
 * it sounds: an EPUB is a ZIP, and **the ZIP spec permits STORED (uncompressed)
 * entries everywhere**. Dropping deflate removes the only part of the format
 * that would have justified a library. A book's XHTML is a few hundred
 * kilobytes; the container is not where the size goes.
 *
 * Three properties this writer guarantees, all of them load-bearing for EPUB:
 *
 *  - **`mimetype` is written exactly as the caller ordered it**, first, stored,
 *    with no extra field. The EPUB OCF spec requires that the first entry be an
 *    uncompressed `mimetype` so a reader can identify the file by byte offset
 *    30 without parsing the central directory. This writer never reorders and
 *    never compresses, so obeying it is the caller's job and staying out of the
 *    way is this file's.
 *  - **Reproducible bytes.** Every entry gets the same fixed DOS timestamp
 *    (1980-01-01), so the same blocks and the same exclusions produce a
 *    byte-identical EPUB. PIPELINE.md's promise is that re-export is cheap and
 *    reproducible; a wall-clock timestamp would make every export differ from
 *    the last one and make "did my exclusion change anything" unanswerable.
 *  - **Loud limits.** Zip64 is not implemented, so anything that would need it
 *    throws naming the entry and the limit. A silently truncated 32-bit size
 *    field produces an archive that opens and is wrong.
 */

// ── CRC32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── entries ─────────────────────────────────────────────────────────────────

export interface ZipEntry {
  /** Forward-slashed, relative, no `.` or `..` segments. */
  path: string;
  data: Uint8Array;
}

/** A UTF-8 text entry. */
export function zipText(path: string, text: string): ZipEntry {
  return { path, data: new TextEncoder().encode(text) };
}

/** Something this writer will not encode. Always names the entry. */
export class ZipError extends Error {
  constructor(message: string) {
    super(`zip: ${message}`);
    this.name = 'ZipError';
  }
}

// The fixed timestamp: 1980-01-01 00:00:00, the earliest a DOS field can hold.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year 0 (=1980), month 1, day 1

const LOCAL_SIG = 0x04034B50;
const CENTRAL_SIG = 0x02014B50;
const EOCD_SIG = 0x06054B50;

const MAX_U32 = 0xFFFFFFFF;
const MAX_U16 = 0xFFFF;

/** General-purpose flag bit 11: the name and comment are UTF-8. */
const FLAG_UTF8 = 0x0800;

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
    this.buf[this.len++] = (v >>> 16) & 0xFF;
    this.buf[this.len++] = (v >>> 24) & 0xFF;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  get offset(): number { return this.len; }

  finish(): Uint8Array { return this.buf.slice(0, this.len); }
}

function checkPath(path: string): Uint8Array {
  if (path.length === 0) throw new ZipError('an entry has an empty path');
  if (path.includes('\\')) {
    throw new ZipError(`entry "${path}" contains a backslash — ZIP paths are forward-slashed`);
  }
  if (path.startsWith('/')) throw new ZipError(`entry "${path}" is absolute — ZIP paths are relative`);
  if (path.split('/').some(seg => seg === '.' || seg === '..' || seg === '')) {
    throw new ZipError(`entry "${path}" has an empty or relative path segment`);
  }
  const name = new TextEncoder().encode(path);
  if (name.length > MAX_U16) throw new ZipError(`entry "${path}" has a name longer than ${MAX_U16} bytes`);
  return name;
}

/**
 * Encode entries into a ZIP archive, stored, in the order given.
 *
 * The order is the caller's and is never changed — see the header on `mimetype`.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_U16) {
    throw new ZipError(`${entries.length} entries exceeds the ${MAX_U16} this writer supports (zip64 is not implemented)`);
  }

  const seen = new Set<string>();
  const out = new Writer();
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number; utf8: boolean }> = [];

  for (const entry of entries) {
    const name = checkPath(entry.path);
    if (seen.has(entry.path)) throw new ZipError(`entry "${entry.path}" appears twice`);
    seen.add(entry.path);

    if (entry.data.length > MAX_U32) {
      throw new ZipError(`entry "${entry.path}" is ${entry.data.length} bytes, past the 4 GiB this writer supports (zip64 is not implemented)`);
    }

    // Bit 11 only when the name actually needs it: setting it unconditionally
    // makes some older readers treat plain ASCII names as UTF-8-flagged, which
    // is harmless but is a difference from what every other EPUB carries.
    const utf8 = name.length !== entry.path.length;
    const crc = crc32(entry.data);
    const offset = out.offset;

    out.u32(LOCAL_SIG);
    out.u16(20);                       // version needed: 2.0
    out.u16(utf8 ? FLAG_UTF8 : 0);
    out.u16(0);                        // method: stored
    out.u16(DOS_TIME);
    out.u16(DOS_DATE);
    out.u32(crc);
    out.u32(entry.data.length);        // compressed size == uncompressed
    out.u32(entry.data.length);
    out.u16(name.length);
    out.u16(0);                        // no extra field — required for mimetype
    out.bytes(name);
    out.bytes(entry.data);

    central.push({ name, crc, size: entry.data.length, offset, utf8 });
  }

  const centralStart = out.offset;
  for (const e of central) {
    out.u32(CENTRAL_SIG);
    out.u16(20);                       // version made by
    out.u16(20);                       // version needed
    out.u16(e.utf8 ? FLAG_UTF8 : 0);
    out.u16(0);                        // stored
    out.u16(DOS_TIME);
    out.u16(DOS_DATE);
    out.u32(e.crc);
    out.u32(e.size);
    out.u32(e.size);
    out.u16(e.name.length);
    out.u16(0);                        // extra
    out.u16(0);                        // comment
    out.u16(0);                        // disk number
    out.u16(0);                        // internal attrs
    out.u32(0);                        // external attrs
    out.u32(e.offset);
    out.bytes(e.name);
  }
  const centralSize = out.offset - centralStart;

  out.u32(EOCD_SIG);
  out.u16(0);                          // this disk
  out.u16(0);                          // disk with the central directory
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0);                          // comment length

  return out.finish();
}
