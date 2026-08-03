/**
 * cover — the caller's own cover image, identified by what it IS.
 *
 * `foundry export --cover <file>` embeds an image the caller supplies. Nothing
 * in the pipeline produced it and nothing in the pipeline reads it: no OCR runs
 * over a cover, no block is formed from it, and no text of any kind comes out of
 * it. It is bytes in, bytes out.
 *
 * Which makes ONE question load-bearing — what is this file? — because the
 * answer becomes a `media-type` in the package document, and a reader that is
 * told `image/jpeg` about a PDF does not fall back to anything: it renders
 * nothing where the cover should be, on a book that opened without an error.
 *
 * So the format is read from the file's MAGIC BYTES and never from its name. A
 * `.jpg` that a converter quietly left as a PNG is the common case, and it is
 * exactly the case an extension check gets wrong. The extension inside the
 * container is then assigned from what was found, not from what was passed in.
 *
 * JPEG and PNG only. They are what every reading system decodes, and refusing
 * the rest here — loudly, naming the file — is cheaper than a cover that is
 * blank in one reader and missing in another.
 */

/** A cover file that cannot be embedded. Always names the file. */
export class CoverError extends Error {
  constructor(message: string) {
    super(`cover: ${message}`);
    this.name = 'CoverError';
  }
}

/** The bytes the caller handed over, and where they came from. */
export interface CoverImage {
  /** Embedded verbatim — never re-encoded, resized, or re-compressed. */
  readonly data: Uint8Array;
  /** The path as the caller gave it. For the error, and for nothing else. */
  readonly sourcePath: string;
}

export interface CoverFormat {
  readonly mediaType: 'image/jpeg' | 'image/png';
  /** The extension the entry gets INSIDE the container, from the magic bytes. */
  readonly extension: 'jpg' | 'png';
}

/** SOI plus the first marker byte. The third byte rules out a bare `FF D8`. */
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF];
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

const startsWith = (data: Uint8Array, magic: readonly number[]): boolean =>
  data.length >= magic.length && magic.every((byte, i) => data[i] === byte);

const hex = (data: Uint8Array, n: number): string =>
  [...data.slice(0, n)].map(b => b.toString(16).padStart(2, '0')).join(' ');

/**
 * What this file is, or a stop that names it.
 *
 * The error carries the leading bytes because that is the one fact that tells
 * the user what they actually handed over — "not a JPEG or a PNG" leaves them
 * guessing, `25 50 44 46` says PDF to anyone who can look it up.
 */
export function coverFormat(cover: CoverImage): CoverFormat {
  const { data, sourcePath } = cover;
  if (data.length === 0) {
    throw new CoverError(`${sourcePath} is empty — there is no image in it to embed.`);
  }
  if (startsWith(data, JPEG_MAGIC)) return { mediaType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(data, PNG_MAGIC)) return { mediaType: 'image/png', extension: 'png' };
  throw new CoverError(
    `${sourcePath} is not a JPEG or a PNG. Its first bytes are ${hex(data, 8)},`
    + ' which match neither. The cover is embedded verbatim and its media type is'
    + ' declared from what the file IS, not from what it is called, so shipping this'
    + ' one would produce a book whose cover no reader can decode. Convert it to JPEG'
    + ' or PNG first; foundry does not re-encode images.',
  );
}
