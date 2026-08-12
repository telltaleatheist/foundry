/**
 * epub-writer — put an unpacked book back into a .epub.
 *
 * The other half of epub-reader.ts. A book is unpacked to a temp directory so
 * its chapters can be served to an <iframe> and edited as text; this packs that
 * directory back into a container an e-reader will open.
 *
 * ── The one rule that is not negotiable ──────────────────────────────────────
 *
 * `mimetype` is the FIRST entry, STORED, with no extra field. The EPUB OCF spec
 * exists so a reader can identify the file by reading byte offset 30 without
 * parsing a central directory, and an EPUB that gets this wrong opens in some
 * readers and is silently rejected by others — which is the worst failure mode
 * available, because it looks like it worked. Everything else in the archive is
 * deflated; only this one entry is special.
 *
 * ── Where the shape came from ────────────────────────────────────────────────
 *
 * The header layout is BookForge's `electron/epub-writer.ts` (a proven hand-
 * assembled ZIP: local header, central directory, EOCD), adapted rather than
 * imported — that module builds an epub out of paragraphs and titles and has no
 * idea what a directory of files is. Two things were added on the way across:
 *
 *   - the UTF-8 name flag (bit 11), which BookForge does not set because its
 *     entry names are all ASCII by construction and ours are whatever the book
 *     called its files;
 *   - a ZIP64 refusal, because a silently truncated 32-bit size field produces
 *     an archive that opens and is wrong. foundry's own writer
 *     (src/export/zip.ts) makes the same call for the same reason.
 *
 * `node:zlib`'s `deflateRawSync` is the whole dependency. A book is a few
 * hundred kilobytes of XHTML; synchronous is measured in single-digit
 * milliseconds and buys the caller a function that cannot half-finish.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Names outside this need bit 11 set so a reader decodes them as UTF-8. */
const ASCII_ONLY = /^[\x20-\x7e]*$/;
const FLAG_UTF8 = 0x0800;

/** 4 GiB. Past it the 32-bit fields lie and ZIP64 is not implemented. */
const SIZE_LIMIT = 0xffffffff;

/**
 * Fixed DOS timestamp — 1980-01-01, the epoch of the format.
 *
 * The same choice foundry's own writer makes: a wall-clock timestamp would make
 * every save of an unchanged book produce different bytes, and "did my edit
 * change anything" becomes unanswerable by comparing two files.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export class EpubWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubWriteError';
  }
}

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = (CRC_TABLE[(c ^ data.readUInt8(i)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pack `members` out of `root` into EPUB bytes.
 *
 * The ORDER of `members` is obeyed exactly and nothing here sorts: the caller
 * knows which entry has to come first, and a writer that reordered would break
 * the one rule above while looking tidier.
 */
export function packEpub(root: string, members: readonly string[]): Promise<Buffer> {
  return packEntries(root, orderForEpub(members));
}

/**
 * `mimetype` first, everything else in the order it arrived.
 *
 * Thrown at rather than repaired when it is missing: a directory with no
 * `mimetype` is not an unpacked EPUB, and inventing one would turn "this is the
 * wrong directory" into a book with a plausible container and nothing in it.
 */
function orderForEpub(members: readonly string[]): string[] {
  if (!members.includes('mimetype')) {
    throw new EpubWriteError(
      'This book has no `mimetype` entry, so it cannot be packed as an EPUB. '
      + '(Every EPUB has one, first and uncompressed — a directory without it was never unpacked from a book.)',
    );
  }
  return ['mimetype', ...members.filter((name) => name !== 'mimetype')];
}

async function packEntries(root: string, members: readonly string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const name of members) {
    const data = await fsp.readFile(path.join(root, ...name.split('/')));
    const nameBuffer = Buffer.from(name, 'utf8');

    // `mimetype` is stored; everything else is deflated. An EMPTY file is also
    // stored — deflating nothing produces a two-byte payload that is larger
    // than the thing it encodes.
    const stored = name === 'mimetype' || data.length === 0;
    const payload = stored ? data : zlib.deflateRawSync(data);
    const method = stored ? 0 : 8;
    const flags = ASCII_ONLY.test(name) ? 0 : FLAG_UTF8;
    const crc = crc32(data);

    if (data.length > SIZE_LIMIT || payload.length > SIZE_LIMIT) {
      throw new EpubWriteError(
        `"${name}" is larger than 4 GiB, which needs ZIP64 — not implemented here. `
        + 'Refusing to write an archive whose size fields would be wrong.',
      );
    }

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);            // no extra field — see the mimetype rule
    nameBuffer.copy(local, 30);
    chunks.push(local, payload);

    const entry = Buffer.alloc(46 + nameBuffer.length);
    entry.writeUInt32LE(SIG_CENTRAL, 0);
    entry.writeUInt16LE(20, 4);            // version made by
    entry.writeUInt16LE(20, 6);            // version needed
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30);            // extra
    entry.writeUInt16LE(0, 32);            // comment
    entry.writeUInt16LE(0, 34);            // disk number
    entry.writeUInt16LE(0, 36);            // internal attributes
    entry.writeUInt32LE(0, 38);            // external attributes
    entry.writeUInt32LE(offset, 42);
    nameBuffer.copy(entry, 46);
    central.push(entry);

    offset += local.length + payload.length;
  }

  const directorySize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                // this disk
  eocd.writeUInt16LE(0, 6);                // disk with the directory
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(directorySize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, ...central, eocd]);
}

/**
 * Write the bytes somewhere, via a temp file in the same directory.
 *
 * A rename is atomic on one volume, so a save that is interrupted leaves the
 * previous book intact rather than a half-written one with the right name. The
 * temp file is beside the target and not in %TEMP% precisely so the rename
 * cannot become a cross-volume copy.
 */
export async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  const target = path.resolve(destination);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.writing`;
  await fsp.writeFile(temporary, bytes);
  await fsp.rename(temporary, target);
}
