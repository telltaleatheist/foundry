/**
 * strings — how foundry puts TEXT into a PDF, and the measurement behind it.
 *
 * ALWAYS a hex string (UTF-16BE with a byte-order mark). Never
 * `PDFString.of`.
 *
 * pdf-lib's literal string writes each character's code point truncated to one
 * byte. `—` becomes 0x14, `“` becomes 0x1C, `ﬁ` becomes 0x01: the text is
 * silently destroyed, and any character whose low byte lands on `(`, `)` or `\`
 * terminates or escapes the string and corrupts every object after it in the
 * same object stream.
 *
 * Measured on the first real document-mode run — three pages of Kershaw,
 * annotations carrying the blocks' own text. 39 annotations were written and
 * the file parsed cleanly; 19 came back. Twenty blocks, including every one on
 * the last page, were simply not in the document, with no error anywhere.
 *
 * This program's payload is a BOOK. Its text is em dashes, curly quotes,
 * ligatures, accented capitals and daggers, and there is no ASCII-only path
 * through it to take. So the encoding is decided once, here, and everything
 * that writes text into a PDF calls it.
 */
import { PDFHexString, PDFString } from '@cantoo/pdf-lib';

export function textString(value: string): PDFHexString {
  return PDFHexString.fromText(value);
}

/**
 * Read a text string back, whichever of the two encodings it is in.
 *
 * Literal strings are accepted on the way IN because other people's tools write
 * them — a reader that let a user retype a heading will have written whatever it
 * writes. They are never produced on the way out.
 */
export function decodeTextString(value: unknown): string | null {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return null;
}
