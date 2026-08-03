/**
 * archive — read a .tar.gz, without a dependency and without a system `tar`.
 *
 * The vendored Tesseract arrives as a tarball (a binary plus its libraries plus
 * language data — several files, unlike a GGUF, which is one). Extracting it
 * needs exactly two things: gunzip, which node:zlib already is, and a reader for
 * the tar container, which is 512-byte headers and nothing else.
 *
 * WHY NOT SHELL OUT TO `tar`. Windows 10 ships bsdtar and macOS and Linux ship
 * one too, so it would usually work — and "usually" is the problem. A packaged
 * foundry that cannot scan because a user's PATH lacks tar, or has a `tar` that
 * is GNU on one machine and bsdtar on another with different flag handling, is a
 * failure with no good error message and nothing the program can do about it.
 * This repo already writes its own ZIP for EPUB output (src/export/zip.ts) for
 * the same reason: the container format is simpler than the dependency.
 *
 * WHAT IT DELIBERATELY DOES NOT SUPPORT: symlinks, hard links, device nodes,
 * ownership, and any entry whose path escapes the destination. A vendored
 * Tesseract is a flat set of regular files in directories, so anything else in
 * that tarball is either a mistake or an attack, and both are worth stopping on
 * rather than skipping quietly. GNU long-name records (`L`/`K`) are read,
 * because bsdtar and GNU tar both emit them for paths past 100 characters.
 */
import { gunzipSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One regular file out of the archive. */
export interface TarEntry {
  /** Slash-separated path as recorded, with any leading `./` removed. */
  name: string;
  data: Buffer;
  /** The unix mode as recorded; only the executable bit is acted on. */
  mode: number;
}

const BLOCK = 512;

/** Trailing NULs and spaces are padding, not content. */
function str(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  return raw.toString('utf-8', 0, end).replace(/\0+$/, '').trim();
}

/**
 * Tar stores numbers as octal text. A field of all NULs/spaces is zero, which is
 * what an unset size or mode looks like.
 */
function octal(block: Buffer, offset: number, length: number): number {
  const text = str(block, offset, length).replace(/[^0-7]/g, '');
  if (text === '') return 0;
  const n = Number.parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The header checksum, which is what distinguishes a real header from the two
 * zero blocks that end an archive — and from garbage.
 *
 * Computed with the checksum field itself read as eight spaces, which is how tar
 * defines it.
 */
function checksumMatches(block: Buffer): boolean {
  const recorded = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  }
  return sum === recorded;
}

/** Every regular file in a gzipped tar, in archive order. */
export function readTarGz(gz: Buffer): TarEntry[] {
  const tar = gunzipSync(gz);
  const entries: TarEntry[] = [];

  let offset = 0;
  /** Set by a preceding GNU long-name record, consumed by the next header. */
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks terminate the archive; one is enough to know
    // there is no further header here.
    if (header.every((b) => b === 0)) break;

    if (!checksumMatches(header)) {
      throw new Error(
        `Corrupt tar: the header at byte ${offset} does not checksum. The archive was `
        + `not extracted.`,
      );
    }

    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]!) || '0';
    const prefix = str(header, 345, 155);
    const base = str(header, 0, 100);
    let name = prefix ? `${prefix}/${base}` : base;
    if (pendingLongName !== null) {
      name = pendingLongName;
      pendingLongName = null;
    }

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error(
        `Corrupt tar: entry '${name}' claims ${size} bytes but the archive ends first.`,
      );
    }

    // 'L' is a GNU long name: its BODY is the name of the entry that follows.
    if (typeflag === 'L') {
      pendingLongName = tar.toString('utf-8', dataStart, dataEnd).replace(/\0+$/, '');
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({
        name: name.replace(/^\.\//, ''),
        data: tar.subarray(dataStart, dataEnd),
        mode: octal(header, 100, 8),
      });
    } else if (typeflag === '5' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
      // Directories are created from the file paths, and pax/long-link records
      // carry no file content this reader needs.
    } else {
      throw new Error(
        `Refusing to extract '${name}': tar entry type '${typeflag}' is not a regular file `
        + `or a directory. A vendored Tesseract is regular files only.`,
      );
    }

    // Entries are padded to a block boundary.
    offset = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK);
  }

  return entries;
}

/**
 * Extract a gzipped tar into `dest`, refusing any path that leaves it.
 *
 * The traversal check is done on the RESOLVED path rather than by looking for
 * `..` in the name, because `a/../../b` and an absolute `/etc/x` and a Windows
 * `C:\x` are three different spellings of the same escape and only resolution
 * catches all of them.
 */
export function extractTarGz(gz: Buffer, dest: string): string[] {
  const root = path.resolve(dest);
  const written: string[] = [];

  for (const entry of readTarGz(gz)) {
    if (entry.name === '' || entry.name.endsWith('/')) continue;
    const target = path.resolve(root, entry.name);
    const rel = path.relative(root, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Refusing to extract '${entry.name}': it resolves outside the destination `
        + `(${target}). Nothing from this archive was installed.`,
      );
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    // Only the executable bit, and only where it means anything. Windows has no
    // mode to set and chmod there is a no-op that can still throw on odd volumes.
    if (process.platform !== 'win32' && (entry.mode & 0o111) !== 0) {
      fs.chmodSync(target, 0o755);
    }
    written.push(target);
  }

  if (written.length === 0) {
    throw new Error('The archive contained no files. Nothing was installed.');
  }
  return written;
}
