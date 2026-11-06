/**
 * engine-meta — reading and writing EPUB and PDF metadata through the engine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contributorFileAs } from '../shared/mint-meta';
import type { DocumentMetadata, MetadataOutcome, MintMeta } from '../shared/types';
import { runEngine } from './engine-run';

// ─────────────────────────────────────────────────────────────────────────────
// epub-meta / pdf-meta
// ─────────────────────────────────────────────────────────────────────────────

/*
 * NOTHING IN THIS SECTION THROWS, for `stampEpub`'s reason turned around: the
 * metadata dialog is a thing somebody opened on a book they are already
 * reading, and a package with two `dc:creator` elements in it — which the
 * engine refuses to write and says so about, by name — must land as a sentence
 * beside the fields rather than as an unhandled rejection somewhere behind the
 * modal. `MetadataOutcome` (shared/types.ts) is that shape.
 */

/**
 * The engine's `--json`, run and parsed.
 *
 * The only OTHER place this app parses the engine's stdout is `runDoctor`, and
 * the shape is deliberately identical: stdout is the result, stderr is the
 * progress, and a run that exits 0 with something that is not JSON on stdout is
 * reported with the first 200 characters of whatever it did say. Guessing at a
 * half-printed object would put invented metadata into a dialog whose Save
 * button writes it straight back into somebody's book.
 */
export async function runMetaCommand(
  args: string[],
  /**
   * Reading a package is milliseconds and rewriting a PDF is seconds, so sixty
   * is far past either and a hang would leave a modal with a spinner in it.
   *
   * It is an argument because ONE command here is not of that order:
   * `vlm-blocks` over a bank that recorded no render sizes measures every page
   * of the PDF again, which for a three-hundred-page scan is minutes. A timeout
   * that fits a metadata read would kill it every time, and the failure would
   * look exactly like an engine that does not have the command.
   */
  timeoutMs = 60_000,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  const run = runEngine(args);
  const timer = setTimeout(() => run.cancel(), timeoutMs);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: said.length > 0 ? said : `foundry ${args[0]} exited ${result.code} and said nothing.`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) as unknown };
  } catch (err) {
    return {
      ok: false,
      reason:
        `foundry ${args[0]} --json answered, but not with JSON (${(err as Error).message}). `
        + `First 200 characters: ${result.stdout.slice(0, 200)}`,
    };
  }
}

/** A field the engine reported, as a string or null. Anything else reads as absent. */
export function metaField(fields: Record<string, unknown>, name: string): string | null {
  const value = fields[name];
  return typeof value === 'string' ? value : null;
}

export function asEpubMetadata(json: unknown): DocumentMetadata {
  const root = (json ?? {}) as Record<string, unknown>;
  const fields = (root['fields'] ?? {}) as Record<string, unknown>;
  return {
    kind: 'epub',
    fields: {
      title: metaField(fields, 'title'),
      creator: metaField(fields, 'creator'),
      language: metaField(fields, 'language'),
      publisher: metaField(fields, 'publisher'),
      date: metaField(fields, 'date'),
      identifier: metaField(fields, 'identifier'),
    },
    uniqueIdentifier: typeof root['uniqueIdentifier'] === 'string' ? root['uniqueIdentifier'] : null,
    counts: (root['counts'] ?? {}) as Record<string, number>,
  };
}

export function asPdfMetadata(json: unknown): DocumentMetadata {
  const root = (json ?? {}) as Record<string, unknown>;
  const fields = (root['fields'] ?? {}) as Record<string, unknown>;
  return {
    kind: 'pdf',
    fields: {
      title: metaField(fields, 'title'),
      author: metaField(fields, 'author'),
      subject: metaField(fields, 'subject'),
      keywords: metaField(fields, 'keywords'),
    },
    pages: typeof fields['pages'] === 'number' ? fields['pages'] : 0,
    creator: metaField(fields, 'creator'),
    producer: metaField(fields, 'producer'),
  };
}

/**
 * A patch turned into flags, dropping every field nobody typed into.
 *
 * ONLY WHAT CHANGED IS SENT. The engine touches only the fields it is given, so
 * a dialog that posted all six back on every save would re-splice a `dc:title`
 * nobody looked at, and would turn a `dc:publisher` the dialog showed as empty
 * into a refusal about blank values. A field left alone is a field the command
 * line never mentions.
 */
export function metaFlags(patch: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    args.push(`--${field}`, value);
  }
  return args;
}

/**
 * Read a book's Dublin Core record: `foundry epub-meta --epub <file> --json`.
 *
 * `epubPath` IS AN EPUB FILE, and it used to be a directory. The argument was
 * the WORKING TREE — the unpacked copy this app edited in place — and the tree,
 * the reader over it and the tab kind that held it are deleted
 * (docs/RENDERER.md §7). What is left that has a `dc:` package in it is a
 * FINISHED EXPORT in a project's `final/` tray, so that is what these two are
 * pointed at, and `exportInTray` (electron/projects.ts) is what decides whether
 * a given path is one.
 *
 * The engine reads either form, so nothing here refuses a directory — it simply
 * is not a thing this app has one of any more.
 */
export async function readEpubMetadata(epubPath: string): Promise<MetadataOutcome> {
  const result = await runMetaCommand(['epub-meta', '--epub', epubPath, '--json']);
  return result.ok ? { ok: true, metadata: asEpubMetadata(result.json) } : result;
}

/**
 * Write a book's Dublin Core fields — THROUGH A SIDE FILE, then over the export.
 *
 * ── WHY THIS GREW A TEMPORARY FILE IT DID NOT USED TO NEED ──────────────────
 *
 * This passed no `--out` and the engine edited the argument where it stood,
 * which is the DIRECTORY form: `epub-meta` splices the OPF inside an unpacked
 * tree and leaves everything else exactly as it was. Against a `.epub` FILE the
 * same call is refused by name — a container is a zip, changing one member means
 * emitting the whole archive again, and writing that archive into the file it is
 * still reading members out of would destroy the book mid-read. So the engine
 * demands `--out`, and it demands one that is not the input.
 *
 * `writePdfMetadata` below met this exact wall for the exact reason and answered
 * it the same way, so this is deliberately its shape line for line: write beside,
 * then ONE rename over the top, so an interrupted save leaves either the old
 * container or the new one and never half of either.
 *
 * ── AND REWRITING AN EXPORT IS NOT THIS APP OVERWRITING AN INPUT ────────────
 *
 * The rule is that Foundry never writes to a document it did not make. A file in
 * `final/` is one it did make: it was cast from the bank minutes ago and can be
 * cast again, and the metadata step this write is recorded as is replayed onto
 * every book made from that position afterwards (`metadataForProduct`). The
 * container on disk is the copy the person is looking at; the step is the part
 * that survives. Nothing the user brought in is touched by either.
 *
 * A RUN THAT CHANGED NOTHING WRITES NOTHING. Every field already saying what it
 * was asked to say is a read wearing a Save button — the engine reports that as
 * `written: false` and emits no archive, so there is no file to move and the
 * export keeps its own bytes rather than being replaced by an identical copy at
 * a new mtime.
 */
export async function writeEpubMetadata(
  epubPath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataOutcome> {
  const flags = metaFlags(patch);
  if (flags.length === 0) return readEpubMetadata(epubPath);
  return spliceEpub(epubPath, flags);
}

/**
 * THE MINT'S OWN STAMP — the whole `MintMeta` block onto one finished EPUB,
 * through the same side-file splice as the flat patch above.
 *
 * The creators go as a SET, replacing whatever the package held (repeatable
 * `--creator`, paired in order with `--creator-file-as` in the "Last, First"
 * spelling shared/mint-meta.ts owns); the subtitle goes even when empty,
 * because empty MEANS removal and a stamp that skipped it would leave a
 * cleared subtitle standing in the file. `language` is the caller's decision,
 * already resolved through the chain rule (`JobRequest.mintMeta` argues it) —
 * this function writes what it is told and decides nothing.
 */
export async function stampMintMetadata(
  epubPath: string,
  meta: MintMeta,
  language: string | undefined,
): Promise<MetadataOutcome> {
  const flags: string[] = ['--title', meta.title || 'Untitled', '--subtitle', meta.subtitle ?? ''];
  for (const one of meta.contributors) {
    const display = [one.first, one.last].filter(Boolean).join(' ');
    if (!display) continue;
    flags.push('--creator', display, '--creator-file-as', contributorFileAs(one));
  }
  if (meta.year?.trim()) flags.push('--date', meta.year.trim());
  const declared = language ?? meta.language;
  if (declared) flags.push('--language', declared);
  return spliceEpub(epubPath, flags);
}

/** One splice, both writers: the side file, the rename, the no-change skip. */
export async function spliceEpub(epubPath: string, flags: readonly string[]): Promise<MetadataOutcome> {
  const beside = path.join(path.dirname(epubPath), `.${path.basename(epubPath)}.meta-tmp`);
  const result = await runMetaCommand(['epub-meta', '--epub', epubPath, '--out', beside, '--json', ...flags]);
  if (!result.ok) {
    await fs.promises.rm(beside, { force: true });
    return result;
  }
  const wrote = (result.json as Record<string, unknown>)['written'] === true;
  if (!wrote) {
    await fs.promises.rm(beside, { force: true });
    return { ok: true, metadata: asEpubMetadata(result.json) };
  }
  try {
    await fs.promises.rename(beside, epubPath);
  } catch (err) {
    await fs.promises.rm(beside, { force: true });
    return {
      ok: false,
      reason:
        `The metadata was written, but the new book could not be put in place of ${epubPath} `
        + `(${(err as Error).message}). The export is unchanged.`,
    };
  }
  return { ok: true, metadata: asEpubMetadata(result.json) };
}

export function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a PDF's Info dictionary: `foundry pdf-meta --pdf <file> --json`. */
export async function readPdfMetadata(pdfPath: string): Promise<MetadataOutcome> {
  const result = await runMetaCommand(['pdf-meta', '--pdf', pdfPath, '--json']);
  return result.ok ? { ok: true, metadata: asPdfMetadata(result.json) } : result;
}

/**
 * Write a PDF's Info dictionary — THROUGH A SIDE FILE, then over the original.
 *
 * `pdf-meta` refuses an `--out` equal to its `--pdf`, and is right to: it
 * re-emits the whole document through pdf-lib rather than patching it, so
 * writing into the file it is parsing would destroy the document mid-read. The
 * app wants the working PDF edited in place all the same, so the engine writes
 * beside it and this renames the result over the top — one filesystem
 * operation, so an interrupted save leaves either the old file or the new one
 * and never half of either.
 *
 * Rewriting the working PDF at all is acceptable because `archive/` still holds
 * the file that came in, byte for byte, and the working copy can be made again
 * from it.
 */
export async function writePdfMetadata(
  pdfPath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataOutcome> {
  const flags = metaFlags(patch);
  if (flags.length === 0) return readPdfMetadata(pdfPath);

  const beside = path.join(path.dirname(pdfPath), `.${path.basename(pdfPath)}.meta-tmp`);
  const result = await runMetaCommand(['pdf-meta', '--pdf', pdfPath, '--out', beside, '--json', ...flags]);
  if (!result.ok) {
    await fs.promises.rm(beside, { force: true });
    return result;
  }
  // A run whose every field already said what it was asked to say writes no
  // file at all — the engine reports that, and there is nothing to move.
  const wrote = (result.json as Record<string, unknown>)['written'] === true;
  if (!wrote) {
    await fs.promises.rm(beside, { force: true });
    return { ok: true, metadata: asPdfMetadata(result.json) };
  }
  try {
    await fs.promises.rename(beside, pdfPath);
  } catch (err) {
    await fs.promises.rm(beside, { force: true });
    return {
      ok: false,
      reason:
        `The metadata was written, but the new PDF could not be put in place of ${pdfPath} `
        + `(${(err as Error).message}). The document is unchanged.`,
    };
  }
  return { ok: true, metadata: asPdfMetadata(result.json) };
}
