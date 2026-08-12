/**
 * workspace — where a conversion's output lives before anyone names a home for it.
 *
 * The OCR dialog used to ask for an output path. It no longer does, and this is
 * the module that made that possible: every conversion writes into
 * `<libraryDir>/workspace/`, opens in a tab the moment it finishes, and is
 * copied OUT of here only when the user presses Save As. Nothing is ever written
 * beside the source PDF, so a folder of scans stays a folder of scans.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `<basename>-<8 hex of the PDF's sha256>.epub`.
 *
 * The hash is of the PDF's CONTENT, not of its path, and that choice buys two
 * things worth a full read of the file:
 *
 *   - the same book converts to the same workspace file no matter where the
 *     user dragged it from, so a second run replaces the first rather than
 *     accumulating `book (1).epub`;
 *   - the READINGS bank gets the same key, so an interrupted run of a book that
 *     has since been moved or renamed still resumes. That bank is GPU-hours; a
 *     key that a rename could break would silently cost them.
 *
 * The basename is kept in the name because a directory of hashes is unusable by
 * a person, and this directory is one a person will eventually open.
 *
 * ── The readings bank ────────────────────────────────────────────────────────
 *
 * `--readings` is passed on EVERY job, always, at `<userData>/readings/<key>.jsonl`.
 * Not a checkbox: there is no version of "read three hundred pages again because
 * the window closed" that anyone wants. The engine decides for itself whether a
 * bank beside a completion marker is a resume or a re-read (README §Reading the
 * pages somewhere else, and only once) — it archives and re-reads a completed
 * one. This app does not second-guess that and has no flag that could.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { readAppSettings } from './app-settings';
import type { WorkspacePlan } from '../shared/types';

/**
 * `<libraryDir>/workspace` — under the user's library, not under userData.
 *
 * A finished book is the user's property. userData is where an app keeps its own
 * bookkeeping (recents, the readings bank, caches) and is not a folder anybody
 * backs up on purpose; the library is `~/Documents/Foundry` by default and is
 * exactly the kind of folder a person syncs.
 *
 * Read on EVERY call rather than cached: the setting is editable while the app
 * is running, and a cached answer would keep writing conversions into the
 * folder the user just moved away from.
 */
export function workspaceDir(): string {
  return path.join(readAppSettings().libraryDir, 'workspace');
}

/**
 * The readings bank stays in userData, deliberately.
 *
 * It is a cache of GPU answers keyed by a hash — bookkeeping, not a document.
 * Putting a directory of `.jsonl` files in the middle of somebody's book folder
 * would make the library worse at being a library, and moving the library must
 * not orphan a bank that a half-finished conversion is going to resume from.
 */
export function readingsDir(): string {
  return path.join(app.getPath('userData'), 'readings');
}

/**
 * True while `filePath` lives in the app's own workspace directory.
 *
 * The one test both main (the recents flag, the unsaved dot) and the epub
 * reader (whether the editor's write-through may target the file itself) apply,
 * so it lives beside the directory it measures against.
 */
export function isManaged(filePath: string): boolean {
  const inside = path.relative(workspaceDir(), path.resolve(filePath));
  return inside.length > 0 && !inside.startsWith('..') && !path.isAbsolute(inside);
}

/**
 * A basename a filesystem, a URL and a person can all live with.
 *
 * The real test document is `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * — spaces, a comma, parentheses and two dots. Everything outside
 * `[A-Za-z0-9._-]` becomes a hyphen, runs collapse, and the result is capped at
 * 64 characters because Windows' 260-character path limit is measured against a
 * userData path that is already ~80 characters deep.
 *
 * Exported because the epub reader keys a user-opened book's workspace copy the
 * same way a conversion is keyed — one naming scheme for the one directory.
 */
export function slugify(name: string): string {
  const slug = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const capped = slug.slice(0, 64);
  // A name made entirely of punctuation would slug to nothing, and a file called
  // `-a1b2c3d4.epub` is a file nobody can identify. The hash still follows.
  return capped.length > 0 ? capped : 'document';
}

/**
 * The first 8 hex characters of the file's sha256.
 *
 * STREAMED, so a 400 MB scan costs one sequential pass and no resident memory.
 * Eight characters is 4 bytes of collision space — plenty against the tens of
 * books one person converts, and short enough that the filename still reads as
 * the book's name with a suffix rather than as a hash.
 */
export function contentKey(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err: Error) => reject(
      new Error(`${filePath} could not be read to key its workspace file: ${err.message}`),
    ));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 8)));
  });
}

/**
 * Where this PDF's conversion goes, and where its answers are banked.
 *
 * The directories are created HERE rather than by the engine, because the engine
 * is handed two paths and a path whose parent does not exist is a run that dies
 * after the last page.
 */
export async function planConversion(inputPath: string): Promise<WorkspacePlan> {
  const resolved = path.resolve(inputPath);
  const key = `${slugify(path.basename(resolved))}-${await contentKey(resolved)}`;
  await fsp.mkdir(workspaceDir(), { recursive: true });
  await fsp.mkdir(readingsDir(), { recursive: true });
  return {
    key,
    outputPath: path.join(workspaceDir(), `${key}.epub`),
    readingsPath: path.join(readingsDir(), `${key}.jsonl`),
  };
}

/**
 * Copy a workspace file to where the user says, and leave the original alone.
 *
 * A COPY and not a move, and that is the whole design of the unsaved dot: the
 * book stays in the workspace whatever happens, so a Save As to a USB stick that
 * was pulled out, or a tab closed by accident, never destroys an hour of GPU.
 * The dot is about losing TRACK of a file, never about losing it.
 */
export async function copyOut(sourcePath: string, destinationPath: string): Promise<void> {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error('That is the file itself — pick somewhere outside the workspace.');
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}
